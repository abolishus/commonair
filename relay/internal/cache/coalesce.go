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
	ctx     context.Context
	cancel  context.CancelFunc
	val     Entry
	err     error
	waiters int
}

// Group coalesces concurrent calls for the same key into one execution.
// The shared work runs on its own context, detached from any single caller:
// a viewer that disconnects stops waiting while the fetch keeps going for the
// others. When the last waiter leaves, the work is cancelled so abandoned
// fetches (for example blocking requests nobody wants any more) cannot pile up.
type Group struct {
	mu    sync.Mutex
	calls map[string]*call
}

// Do runs fn once per key among concurrent callers and waits for its result
// or for ctx to end. fn receives the call's context, which is cancelled when
// every caller has gone; fn should also bound its own run time.
func (g *Group) Do(ctx context.Context, key string, fn func(context.Context) (Entry, error)) (Entry, error) {
	g.mu.Lock()
	if g.calls == nil {
		g.calls = map[string]*call{}
	}
	c, ok := g.calls[key]
	if !ok {
		cctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		c = &call{done: make(chan struct{}), ctx: cctx, cancel: cancel}
		g.calls[key] = c
		go g.run(key, c, fn)
	}
	c.waiters++
	g.mu.Unlock()

	select {
	case <-c.done:
		g.leave(key, c)
		return c.val, c.err
	case <-ctx.Done():
		g.leave(key, c)
		return Entry{}, ctx.Err()
	}
}

func (g *Group) leave(key string, c *call) {
	g.mu.Lock()
	defer g.mu.Unlock()
	c.waiters--
	if c.waiters == 0 {
		// Nobody is waiting: abort the work and let the next caller start afresh.
		c.cancel()
		if g.calls[key] == c {
			delete(g.calls, key)
		}
	}
}

func (g *Group) run(key string, c *call, fn func(context.Context) (Entry, error)) {
	defer func() {
		g.mu.Lock()
		if g.calls[key] == c {
			delete(g.calls, key)
		}
		g.mu.Unlock()
		c.cancel()
		close(c.done)
	}()
	c.val, c.err = fn(c.ctx)
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
// fetch gets a context that ends when no caller is waiting any more.
func (s *Store) Get(ctx context.Context, key string, fetch func(context.Context) (Entry, error)) (Entry, error) {
	if e, ok := s.LRU.Get(key); ok {
		return e, nil
	}
	return s.group.Do(ctx, key, func(cctx context.Context) (Entry, error) {
		// A call that finished just before this one started may have filled it.
		if e, ok := s.LRU.Get(key); ok {
			return e, nil
		}
		e, err := fetch(cctx)
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
