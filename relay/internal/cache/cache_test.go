// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package cache

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func body(n int) []byte { return []byte(strings.Repeat("x", n)) }

func TestLRUEvictsBySize(t *testing.T) {
	c := NewLRU(4000)
	for _, k := range []string{"a", "b", "c"} {
		if !c.Put(k, Entry{Body: body(900)}) {
			t.Fatalf("put %s refused", k)
		}
	}
	// Touch "a" so "b" becomes least recently used.
	if _, ok := c.Get("a"); !ok {
		t.Fatal("a missing")
	}
	c.Put("d", Entry{Body: body(900)})
	c.Put("e", Entry{Body: body(900)})
	if _, ok := c.Get("b"); ok {
		t.Fatal("b should have been evicted first")
	}
	for _, k := range []string{"a", "d", "e"} {
		if _, ok := c.Get(k); !ok {
			t.Fatalf("%s evicted too early", k)
		}
	}
	if c.Bytes() > 4000 {
		t.Fatalf("used %d over capacity", c.Bytes())
	}
}

func TestLRUAccountingOnReplace(t *testing.T) {
	c := NewLRU(10_000)
	c.Put("k", Entry{Body: body(1000)})
	before := c.Bytes()
	c.Put("k", Entry{Body: body(500)})
	if c.Len() != 1 || c.Bytes() != before-500 {
		t.Fatalf("len=%d bytes=%d (before %d)", c.Len(), c.Bytes(), before)
	}
}

func TestLRURefusesHugeObjects(t *testing.T) {
	c := NewLRU(4000)
	c.Put("small", Entry{Body: body(100)})
	if c.Put("huge", Entry{Body: body(1200)}) {
		t.Fatal("object over a quarter of capacity was cached")
	}
	if _, ok := c.Get("small"); !ok {
		t.Fatal("huge object evicted the working set")
	}
}

func TestLRUExpiry(t *testing.T) {
	c := NewLRU(10_000)
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }
	c.Put("p", Entry{Body: body(10), Expires: now.Add(time.Second)})
	if _, ok := c.Get("p"); !ok {
		t.Fatal("fresh entry missing")
	}
	now = now.Add(time.Second)
	if _, ok := c.Get("p"); ok {
		t.Fatal("expired entry served")
	}
	if c.Len() != 0 || c.Bytes() != 0 {
		t.Fatal("expired entry not removed")
	}
}

func TestStoreCoalescesMisses(t *testing.T) {
	s := NewStore(1 << 20)
	const n = 50
	release := make(chan struct{})
	var fetches atomic.Int32
	fetch := func() (Entry, error) {
		fetches.Add(1)
		<-release
		return Entry{Body: []byte("segment")}, nil
	}
	var wg sync.WaitGroup
	results := make(chan string, n)
	for range n {
		wg.Go(func() {
			e, err := s.Get(context.Background(), "seg1", fetch)
			if err != nil {
				results <- "err:" + err.Error()
				return
			}
			results <- string(e.Body)
		})
	}
	waitFor(t, func() bool { return s.group.waiters("seg1") == n })
	close(release)
	wg.Wait()
	close(results)
	for r := range results {
		if r != "segment" {
			t.Fatalf("result %q", r)
		}
	}
	if got := fetches.Load(); got != 1 {
		t.Fatalf("%d origin fetches for %d concurrent misses, want 1", got, n)
	}
	// Now cached: no further fetch.
	if _, err := s.Get(context.Background(), "seg1", fetch); err != nil || fetches.Load() != 1 {
		t.Fatalf("hit refetched: %v %d", err, fetches.Load())
	}
}

func TestStoreCancelledWaiterDoesNotAbortFetch(t *testing.T) {
	s := NewStore(1 << 20)
	release := make(chan struct{})
	var fetches atomic.Int32
	fetch := func() (Entry, error) {
		fetches.Add(1)
		<-release
		return Entry{Body: []byte("ok")}, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := s.Get(ctx, "k", fetch)
		done <- err
	}()
	waitFor(t, func() bool { return s.group.waiters("k") == 1 })
	other := make(chan string, 1)
	go func() {
		e, _ := s.Get(context.Background(), "k", fetch)
		other <- string(e.Body)
	}()
	waitFor(t, func() bool { return s.group.waiters("k") == 2 })
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled waiter got %v", err)
	}
	close(release)
	if got := <-other; got != "ok" || fetches.Load() != 1 {
		t.Fatalf("other waiter got %q after %d fetches", got, fetches.Load())
	}
}

func TestStoreDoesNotCacheErrors(t *testing.T) {
	s := NewStore(1 << 20)
	var fetches atomic.Int32
	boom := errors.New("origin down")
	fetch := func() (Entry, error) {
		fetches.Add(1)
		return Entry{}, boom
	}
	for range 3 {
		if _, err := s.Get(context.Background(), "k", fetch); !errors.Is(err, boom) {
			t.Fatalf("got %v", err)
		}
	}
	if fetches.Load() != 3 {
		t.Fatalf("errors were cached: %d fetches", fetches.Load())
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(time.Millisecond)
	}
}
