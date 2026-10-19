// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package accounting counts what the relay actually delivered to each viewer
// session, tracks active viewers for admission control, and measures egress.
package accounting

import (
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/abolishus/commonair/relay/internal/tokens"
)

type counts struct {
	segments int64
	bytes    int64
}

// Ledger accumulates per-session bytes and segments for the current receipt
// period. Bytes are added as they are written to the viewer, so an aborted
// response is reported only up to what was written. Only media objects are
// recorded here; playlists never are (receipts are media-only).
type Ledger struct {
	mu      sync.Mutex
	start   time.Time
	entries map[string]*counts
	total   atomic.Int64
}

// NewLedger starts the first period at start.
func NewLedger(start time.Time) *Ledger {
	return &Ledger{start: start, entries: map[string]*counts{}}
}

func (l *Ledger) entry(sid string) *counts {
	c, ok := l.entries[sid]
	if !ok {
		c = &counts{}
		l.entries[sid] = c
	}
	return c
}

// AddBytes records n bytes written to session sid.
func (l *Ledger) AddBytes(sid string, n int64) {
	if n <= 0 {
		return
	}
	l.total.Add(n)
	l.mu.Lock()
	l.entry(sid).bytes += n
	l.mu.Unlock()
}

// AddSegment records one media object delivered completely to sid.
func (l *Ledger) AddSegment(sid string) {
	l.mu.Lock()
	l.entry(sid).segments++
	l.mu.Unlock()
}

// TotalBytes is the monotonic count of bytes written since start (for egress rate).
func (l *Ledger) TotalBytes() int64 { return l.total.Load() }

// Period is one closed accounting window.
type Period struct {
	Start, End time.Time
	Entries    []tokens.ReceiptEntry
}

// Cut closes the current period at end and starts the next one. Entries are
// sorted by session id for stable receipts.
func (l *Ledger) Cut(end time.Time) Period {
	l.mu.Lock()
	entries, start := l.entries, l.start
	l.entries, l.start = map[string]*counts{}, end
	l.mu.Unlock()

	p := Period{Start: start, End: end, Entries: make([]tokens.ReceiptEntry, 0, len(entries))}
	for sid, c := range entries {
		if c.bytes == 0 && c.segments == 0 {
			continue
		}
		p.Entries = append(p.Entries, tokens.ReceiptEntry{SessionID: sid, Segments: c.segments, Bytes: c.bytes})
	}
	sort.Slice(p.Entries, func(i, j int) bool { return p.Entries[i].SessionID < p.Entries[j].SessionID })
	return p
}

// ViewerWindow is how long a session counts as active after its last request.
// Players reload playlists every few seconds at most, so 30 s is generous.
const ViewerWindow = 30 * time.Second

// Viewers tracks active sessions and enforces the relay's viewer limit.
type Viewers struct {
	mu        sync.Mutex
	max       int
	lastSeen  map[string]time.Time
	lastPrune time.Time
}

// NewViewers limits concurrent sessions to limit (at least 1).
func NewViewers(limit int) *Viewers {
	if limit < 1 {
		limit = 1
	}
	return &Viewers{max: limit, lastSeen: map[string]time.Time{}}
}

// Admit marks sid active. A known session is always admitted; a new one only
// while the relay is below its limit.
func (v *Viewers) Admit(sid string, now time.Time) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if now.Sub(v.lastPrune) >= time.Second {
		v.prune(now)
	}
	if _, ok := v.lastSeen[sid]; ok {
		v.lastSeen[sid] = now
		return true
	}
	if len(v.lastSeen) >= v.max {
		v.prune(now)
		if len(v.lastSeen) >= v.max {
			return false
		}
	}
	v.lastSeen[sid] = now
	return true
}

// Touch marks sid active only if it is already a known, active session. A
// draining relay keeps serving the viewers it has but takes no new ones.
func (v *Viewers) Touch(sid string, now time.Time) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	seen, ok := v.lastSeen[sid]
	if !ok || now.Sub(seen) > ViewerWindow {
		return false
	}
	v.lastSeen[sid] = now
	return true
}

func (v *Viewers) prune(now time.Time) {
	v.lastPrune = now
	for sid, seen := range v.lastSeen {
		if now.Sub(seen) > ViewerWindow {
			delete(v.lastSeen, sid)
		}
	}
}

// Count is the number of sessions active within ViewerWindow.
func (v *Viewers) Count(now time.Time) int {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.prune(now)
	return len(v.lastSeen)
}

// Max is the configured limit.
func (v *Viewers) Max() int { return v.max }

// MaxViewers derives the viewer limit from declared capacity, assuming each
// viewer pulls at most perViewerMbps on average.
func MaxViewers(capacityMbps int, perViewerMbps float64) int {
	if perViewerMbps <= 0 {
		perViewerMbps = DefaultPerViewerMbps
	}
	n := int(math.Floor(float64(capacityMbps) / perViewerMbps))
	if n < 1 {
		return 1
	}
	return n
}

// DefaultPerViewerMbps is a conservative average for a 1080p source rendition.
const DefaultPerViewerMbps = 5.0

// Meter is an exponentially weighted moving average of egress in Mbps with a
// time constant, so irregular sampling still weights by elapsed time.
type Meter struct {
	mu        sync.Mutex
	tau       time.Duration
	lastBytes int64
	lastAt    time.Time
	mbps      float64
	primed    bool
}

// NewMeter returns a meter with time constant tau (for example 30 s).
func NewMeter(tau time.Duration) *Meter { return &Meter{tau: tau} }

// Sample feeds the monotonic byte total observed at now.
func (m *Meter) Sample(totalBytes int64, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.primed {
		m.lastBytes, m.lastAt, m.primed = totalBytes, now, true
		return
	}
	dt := now.Sub(m.lastAt)
	if dt <= 0 {
		return
	}
	rate := float64(totalBytes-m.lastBytes) * 8 / dt.Seconds() / 1e6
	alpha := 1 - math.Exp(-dt.Seconds()/m.tau.Seconds())
	m.mbps += alpha * (rate - m.mbps)
	m.lastBytes, m.lastAt = totalBytes, now
}

// Mbps is the current average.
func (m *Meter) Mbps() float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mbps
}
