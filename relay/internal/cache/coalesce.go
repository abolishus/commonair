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

// forget detaches every in-flight call whose key match accepts: callers already
// waiting keep their result, later callers start a fresh call.
func (g *Group) forget(match func(key string) bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for key := range g.calls {
		if match(key) {
			delete(g.calls, key)
		}
	}
}

// Store is a pull-through cache: hits come from the LRU, concurrent misses
// share one fetch, and successful results are cached.
//
// Keys are "<kind>:<path>" (for example "m:live/alice/seg1.mp4"); DeletePrefix
// matches on the path part, so one purge covers every kind of entry for a path.
type Store struct {
	LRU   *LRU
	group Group
	tombs tombstones
	// beforePut runs between a fill's tombstone check and its Put (tests).
	beforePut func(key string)
}

// NewStore returns a Store with an LRU of capacity bytes.
func NewStore(capacity int64) *Store { return &Store{LRU: NewLRU(capacity)} }

// Get returns the cached entry for key or fetches it. Errors are not cached.
// fetch gets a context that ends when no caller is waiting any more. A fill
// that was in flight when a purge covered its path is dropped: nothing is
// cached and every waiter gets ErrPurged.
func (s *Store) Get(ctx context.Context, key string, fetch func(context.Context) (Entry, error)) (Entry, error) {
	if e, ok := s.LRU.Get(key); ok {
		return e, nil
	}
	return s.group.Do(ctx, key, func(cctx context.Context) (Entry, error) {
		// A call that finished just before this one started may have filled it.
		if e, ok := s.LRU.Get(key); ok {
			return e, nil
		}
		gen := s.tombs.generation()
		e, err := fetch(cctx)
		if err != nil {
			return e, err
		}
		if s.tombs.coveredSince(PathOf(key), gen) {
			return Entry{}, ErrPurged
		}
		if s.beforePut != nil {
			s.beforePut(key)
		}
		s.LRU.Put(key, e)
		// A purge that ran wholly between the check above and the Put found
		// nothing to evict; its tombstone is already up, so look again.
		if s.tombs.coveredSince(PathOf(key), gen) {
			s.LRU.Delete(key)
			return Entry{}, ErrPurged
		}
		return e, nil
	})
}

// WithTTL is a convenience for short-lived entries such as playlists.
func WithTTL(e Entry, ttl time.Duration) Entry {
	e.Expires = time.Now().Add(ttl)
	return e
}
