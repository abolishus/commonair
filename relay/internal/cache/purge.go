// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package cache

import (
	"errors"
	"strings"
	"sync"
	"time"
)

// ErrPurged is returned to the waiters of a fill whose path a purge covered
// while the fill was in flight (batch 7 decision (x), ADR 0016 Amendment 1).
var ErrPurged = errors.New("purged while fetching")

// TombstoneTTL is how long a purge is remembered: longer than any origin fetch
// (the media timeout is 30 s), so every fill that started before the purge
// finishes while its tombstone still stands.
const TombstoneTTL = 60 * time.Second

// PathOf is the path part of a cache key ("m:live/a/x.mp4" is "live/a/x.mp4").
// A key without a kind is all path.
func PathOf(key string) string {
	if i := strings.IndexByte(key, ':'); i >= 0 {
		return key[i+1:]
	}
	return key
}

type tombstone struct {
	prefix  string
	gen     uint64
	expires time.Time
}

// tombstones remembers recent purges. Each purge gets the next generation; a
// fill reads the generation when it starts and is dropped if a purge with a
// later generation covers its path.
type tombstones struct {
	mu   sync.Mutex
	gen  uint64
	list []tombstone
	now  func() time.Time
}

func (t *tombstones) clock() time.Time {
	if t.now != nil {
		return t.now()
	}
	return time.Now()
}

func (t *tombstones) generation() uint64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.gen
}

func (t *tombstones) add(prefix string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.clock()
	t.gen++
	t.prune(now)
	t.list = append(t.list, tombstone{prefix: prefix, gen: t.gen, expires: now.Add(TombstoneTTL)})
}

// prune drops expired tombstones; the caller holds mu.
func (t *tombstones) prune(now time.Time) {
	kept := t.list[:0]
	for _, ts := range t.list {
		if now.Before(ts.expires) {
			kept = append(kept, ts)
		}
	}
	t.list = kept
}

// coveredSince reports whether an unexpired purge newer than gen covers path.
func (t *tombstones) coveredSince(path string, gen uint64) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.clock()
	for _, ts := range t.list {
		if ts.gen > gen && now.Before(ts.expires) && strings.HasPrefix(path, ts.prefix) {
			return true
		}
	}
	return false
}

// DeletePrefix evicts every cached entry whose path starts with prefix, detaches
// in-flight fills for those paths (later callers fetch afresh) and keeps a
// tombstone for TombstoneTTL, so a fill that was in flight is dropped instead of
// cached. It returns the number of entries evicted.
func (s *Store) DeletePrefix(prefix string) int {
	match := func(key string) bool { return strings.HasPrefix(PathOf(key), prefix) }
	// The tombstone first: a fill finishing between the eviction and the
	// tombstone would otherwise be cached.
	s.tombs.add(prefix)
	s.group.forget(match)
	return s.LRU.DeleteFunc(match)
}

// Tombstoned reports whether a purge covering path happened within TombstoneTTL.
func (s *Store) Tombstoned(path string) bool { return s.tombs.coveredSince(path, 0) }

// SetClock replaces the clock of the tombstones and of entry expiry (tests).
func (s *Store) SetClock(now func() time.Time) {
	s.tombs.mu.Lock()
	s.tombs.now = now
	s.tombs.mu.Unlock()
	s.LRU.mu.Lock()
	s.LRU.now = now
	s.LRU.mu.Unlock()
}
