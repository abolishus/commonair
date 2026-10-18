// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package cache holds the relay's in-memory, size-bounded object cache and
// the request coalescing that keeps N concurrent misses to one origin fetch.
package cache

import (
	"container/list"
	"sync"
	"time"
)

// Entry is a cached origin response body.
type Entry struct {
	Body        []byte
	ContentType string
	// Expires is zero for immutable objects (media segments).
	Expires time.Time
}

func (e Entry) size(key string) int64 { return int64(len(e.Body) + len(e.ContentType) + len(key) + 64) }

type item struct {
	key   string
	entry Entry
	size  int64
}

// LRU is a least-recently-used cache bounded by total bytes. It is safe for
// concurrent use.
type LRU struct {
	mu       sync.Mutex
	capacity int64
	used     int64
	ll       *list.List
	items    map[string]*list.Element
	now      func() time.Time
}

// NewLRU returns a cache holding at most capacity bytes (bodies plus a small
// per-entry overhead).
func NewLRU(capacity int64) *LRU {
	return &LRU{capacity: capacity, ll: list.New(), items: map[string]*list.Element{}, now: time.Now}
}

// Get returns a live entry and marks it recently used. Expired entries are dropped.
func (c *LRU) Get(key string) (Entry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return Entry{}, false
	}
	it, _ := el.Value.(*item)
	if !it.entry.Expires.IsZero() && !c.now().Before(it.entry.Expires) {
		c.removeElement(el)
		return Entry{}, false
	}
	c.ll.MoveToFront(el)
	return it.entry, true
}

// Put stores an entry, evicting least-recently-used entries to make room.
// Entries larger than a quarter of the capacity are not cached, so one huge
// object cannot flush the whole working set.
func (c *LRU) Put(key string, e Entry) bool {
	size := e.size(key)
	c.mu.Lock()
	defer c.mu.Unlock()
	if size > c.capacity/4 {
		return false
	}
	if el, ok := c.items[key]; ok {
		c.removeElement(el)
	}
	for c.used+size > c.capacity {
		oldest := c.ll.Back()
		if oldest == nil {
			break
		}
		c.removeElement(oldest)
	}
	c.items[key] = c.ll.PushFront(&item{key: key, entry: e, size: size})
	c.used += size
	return true
}

func (c *LRU) removeElement(el *list.Element) {
	it, _ := el.Value.(*item)
	c.ll.Remove(el)
	delete(c.items, it.key)
	c.used -= it.size
}

// Bytes is the current accounted size.
func (c *LRU) Bytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.used
}

// Len is the number of entries.
func (c *LRU) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}
