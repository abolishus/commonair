// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package cache

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPathOf(t *testing.T) {
	for in, want := range map[string]string{
		"m:live/a/x.mp4":      "live/a/x.mp4",
		"pl:dvr/v/index.m3u8": "dvr/v/index.m3u8",
		"plain":               "plain",
		"pl:live/a/i.m3u8?x":  "live/a/i.m3u8?x",
	} {
		if got := PathOf(in); got != want {
			t.Errorf("PathOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLRUDeleteFunc(t *testing.T) {
	c := NewLRU(1 << 20)
	for _, k := range []string{"m:dvr/a/1.mp4", "m:dvr/a/2.mp4", "pl:dvr/a/index.m3u8", "m:dvr/b/1.mp4", "m:live/a/1.mp4"} {
		c.Put(k, Entry{Body: body(10)})
	}
	before := c.Bytes()
	n := c.DeleteFunc(func(k string) bool { return PathOf(k)[:6] == "dvr/a/" })
	if n != 3 || c.Len() != 2 {
		t.Fatalf("deleted %d, left %d", n, c.Len())
	}
	if c.Bytes() >= before {
		t.Fatal("accounted size did not shrink")
	}
	if _, ok := c.Get("m:dvr/b/1.mp4"); !ok {
		t.Fatal("another VOD was evicted")
	}
	if c.DeleteFunc(func(string) bool { return false }) != 0 {
		t.Fatal("deleted with a match that accepts nothing")
	}
}

func TestStoreDeletePrefixEvictsOnlyThePrefix(t *testing.T) {
	s := NewStore(1 << 20)
	fill := func(key string) {
		t.Helper()
		if _, err := s.Get(context.Background(), key, func(context.Context) (Entry, error) { return Entry{Body: body(5)}, nil }); err != nil {
			t.Fatal(err)
		}
	}
	for _, k := range []string{"m:dvr/v1/a.mp4", "pl:dvr/v1/index.m3u8", "m:dvr/v10/a.mp4", "m:live/alice/s.mp4", "m:live/alicex/s.mp4"} {
		fill(k)
	}
	if n := s.DeletePrefix("dvr/v1/"); n != 2 {
		t.Fatalf("evicted %d, want 2 (dvr/v10/ must survive)", n)
	}
	if n := s.DeletePrefix("live/alice/"); n != 1 {
		t.Fatalf("evicted %d, want 1 (live/alicex/ must survive)", n)
	}
	if s.LRU.Len() != 2 {
		t.Fatalf("left %d entries", s.LRU.Len())
	}
	if !s.Tombstoned("dvr/v1/a.mp4") || s.Tombstoned("dvr/v10/a.mp4") {
		t.Fatal("tombstone covers the wrong paths")
	}
}

// A fill in flight when its prefix is purged is dropped: its waiters get
// ErrPurged and nothing is cached; a caller arriving after the purge starts a
// fresh fetch instead of joining the purged one.
func TestStoreDeletePrefixDropsInFlightFill(t *testing.T) {
	s := NewStore(1 << 20)
	release := make(chan struct{})
	started := make(chan struct{})
	var fetches atomic.Int32
	slow := func(context.Context) (Entry, error) {
		if fetches.Add(1) == 1 {
			close(started)
			<-release
		}
		return Entry{Body: body(5)}, nil
	}
	var wg sync.WaitGroup
	errs := make([]error, 3)
	for i := range 3 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = s.Get(context.Background(), "m:dvr/v/seg.mp4", slow)
		}(i)
	}
	<-started
	waitFor(t, func() bool { return s.group.waiters("m:dvr/v/seg.mp4") == 3 })
	s.DeletePrefix("dvr/v/")
	if s.group.waiters("m:dvr/v/seg.mp4") != 0 {
		t.Fatal("the purged call is still joinable")
	}
	// A caller after the purge gets its own fetch.
	if _, err := s.Get(context.Background(), "m:dvr/v/seg.mp4", slow); err != nil {
		t.Fatalf("fresh fetch after purge: %v", err)
	}
	if fetches.Load() != 2 {
		t.Fatalf("fetches = %d, want 2", fetches.Load())
	}
	close(release)
	wg.Wait()
	for i, err := range errs {
		if !errors.Is(err, ErrPurged) {
			t.Fatalf("waiter %d: %v, want ErrPurged", i, err)
		}
	}
	// The fresh fetch (started after the purge) was cached; the purged one was not.
	if _, ok := s.LRU.Get("m:dvr/v/seg.mp4"); !ok {
		t.Fatal("the post-purge fill should be cached")
	}
	if fetches.Load() != 2 {
		t.Fatal("unexpected extra fetch")
	}
}

func TestStoreFillAfterPurgeIsCached(t *testing.T) {
	s := NewStore(1 << 20)
	s.DeletePrefix("live/a/")
	e, err := s.Get(context.Background(), "m:live/a/x.mp4", func(context.Context) (Entry, error) { return Entry{Body: body(3)}, nil })
	if err != nil || len(e.Body) != 3 {
		t.Fatalf("got %v %v", e, err)
	}
	if _, ok := s.LRU.Get("m:live/a/x.mp4"); !ok {
		t.Fatal("a fill that started after the purge must be cached")
	}
}

func TestTombstonesExpire(t *testing.T) {
	s := NewStore(1 << 20)
	now := time.Unix(1_000, 0)
	s.SetClock(func() time.Time { return now })
	s.DeletePrefix("dvr/v/")
	if !s.Tombstoned("dvr/v/a.mp4") {
		t.Fatal("tombstone missing")
	}
	now = now.Add(TombstoneTTL - time.Millisecond)
	if !s.Tombstoned("dvr/v/a.mp4") {
		t.Fatal("tombstone expired early")
	}
	now = now.Add(time.Millisecond)
	if s.Tombstoned("dvr/v/a.mp4") {
		t.Fatal("tombstone outlived its TTL")
	}
	// Expired tombstones are pruned on the next purge.
	s.DeletePrefix("dvr/w/")
	s.tombs.mu.Lock()
	n := len(s.tombs.list)
	s.tombs.mu.Unlock()
	if n != 1 {
		t.Fatalf("%d tombstones kept, want 1", n)
	}
}

// An expired tombstone no longer drops a fill that started before it.
func TestExpiredTombstoneDoesNotDropFill(t *testing.T) {
	s := NewStore(1 << 20)
	now := time.Unix(1_000, 0)
	s.SetClock(func() time.Time { return now })
	_, err := s.Get(context.Background(), "m:dvr/v/a.mp4", func(context.Context) (Entry, error) {
		s.DeletePrefix("dvr/v/")
		now = now.Add(TombstoneTTL)
		return Entry{Body: body(1)}, nil
	})
	if err != nil {
		t.Fatalf("got %v", err)
	}
}
