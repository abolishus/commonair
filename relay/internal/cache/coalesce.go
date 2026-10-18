// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package cache

import (
	"context"
	"sync"
	"time"
)

type call struct {
	done    chan struct{}
	val     Entry
	err     error
	waiters int
}

// Group coalesces concurrent calls for the same key into one execution.
// Unlike a plain singleflight, the shared work runs detached from any single
// caller: a viewer that disconnects stops waiting, but the fetch keeps going
// for everyone else.
type Group struct {
	mu    sync.Mutex
	calls map[string]*call
}

// Do runs fn once per key among concurrent callers and waits for its result
// or for ctx to end. fn must bound its own run time.
func (g *Group) Do(ctx context.Context, key string, fn func() (Entry, error)) (Entry, error) {
	g.mu.Lock()
	if g.calls == nil {
		g.calls = map[string]*call{}
	}
	c, ok := g.calls[key]
	if !ok {
		c = &call{done: make(chan struct{})}
		g.calls[key] = c
		go g.run(key, c, fn)
	}
	c.waiters++
	g.mu.Unlock()

	defer func() {
		g.mu.Lock()
		c.waiters--
		g.mu.Unlock()
	}()
	select {
	case <-c.done:
		return c.val, c.err
	case <-ctx.Done():
		return Entry{}, ctx.Err()
	}
}

func (g *Group) run(key string, c *call, fn func() (Entry, error)) {
	defer func() {
		g.mu.Lock()
		delete(g.calls, key)
		g.mu.Unlock()
		close(c.done)
	}()
	c.val, c.err = fn()
}

// waiters is the number of callers currently waiting on key (tests only).
func (g *Group) waiters(key string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	if c, ok := g.calls[key]; ok {
		return c.waiters
	}
	return 0
}

// Store is a pull-through cache: hits come from the LRU, concurrent misses
// share one fetch, and successful results are cached.
type Store struct {
	LRU   *LRU
	group Group
}

// NewStore returns a Store with an LRU of capacity bytes.
func NewStore(capacity int64) *Store { return &Store{LRU: NewLRU(capacity)} }

// Get returns the cached entry for key or fetches it. Errors are not cached.
func (s *Store) Get(ctx context.Context, key string, fetch func() (Entry, error)) (Entry, error) {
	if e, ok := s.LRU.Get(key); ok {
		return e, nil
	}
	return s.group.Do(ctx, key, func() (Entry, error) {
		// A call that finished just before this one started may have filled it.
		if e, ok := s.LRU.Get(key); ok {
			return e, nil
		}
		e, err := fetch()
		if err == nil {
			s.LRU.Put(key, e)
		}
		return e, err
	})
}

// WithTTL is a convenience for short-lived entries such as playlists.
func WithTTL(e Entry, ttl time.Duration) Entry {
	e.Expires = time.Now().Add(ttl)
	return e
}
