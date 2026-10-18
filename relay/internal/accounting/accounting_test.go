// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package accounting

import (
	"math"
	"sync"
	"testing"
	"time"
)

func TestLedgerCutsPeriods(t *testing.T) {
	t0 := time.Unix(1700000000, 0)
	l := NewLedger(t0)
	l.AddBytes("b", 100)
	l.AddSegment("b")
	l.AddBytes("a", 50)
	l.AddBytes("a", 25)
	l.AddSegment("a")
	l.AddSegment("a")
	l.AddBytes("c", 0) // no-op: never creates an empty entry

	p := l.Cut(t0.Add(time.Minute))
	if !p.Start.Equal(t0) || !p.End.Equal(t0.Add(time.Minute)) {
		t.Fatalf("period %v..%v", p.Start, p.End)
	}
	if len(p.Entries) != 2 || p.Entries[0].SessionID != "a" || p.Entries[1].SessionID != "b" {
		t.Fatalf("entries %+v", p.Entries)
	}
	if p.Entries[0].Bytes != 75 || p.Entries[0].Segments != 2 || p.Entries[1].Bytes != 100 || p.Entries[1].Segments != 1 {
		t.Fatalf("entries %+v", p.Entries)
	}
	next := l.Cut(t0.Add(2 * time.Minute))
	if len(next.Entries) != 0 || !next.Start.Equal(t0.Add(time.Minute)) {
		t.Fatalf("second period not fresh: %+v", next)
	}
	if l.TotalBytes() != 175 {
		t.Fatalf("total %d", l.TotalBytes())
	}
}

func TestLedgerConcurrentWritesAreExact(t *testing.T) {
	l := NewLedger(time.Now())
	var wg sync.WaitGroup
	var cut []Period
	var mu sync.Mutex
	for range 16 {
		wg.Go(func() {
			for range 1000 {
				l.AddBytes("s", 3)
			}
		})
	}
	wg.Go(func() {
		for range 20 {
			p := l.Cut(time.Now())
			mu.Lock()
			cut = append(cut, p)
			mu.Unlock()
		}
	})
	wg.Wait()
	cut = append(cut, l.Cut(time.Now()))
	var sum int64
	for _, p := range cut {
		for _, e := range p.Entries {
			sum += e.Bytes
		}
	}
	if sum != 16*1000*3 {
		t.Fatalf("periods sum to %d, want %d (bytes lost or double counted across cuts)", sum, 16*1000*3)
	}
}

func TestViewersAdmission(t *testing.T) {
	now := time.Unix(1000, 0)
	v := NewViewers(2)
	if !v.Admit("a", now) || !v.Admit("b", now) {
		t.Fatal("under limit refused")
	}
	if v.Admit("c", now) {
		t.Fatal("over limit admitted")
	}
	if !v.Admit("a", now.Add(time.Second)) {
		t.Fatal("known session refused at the limit")
	}
	// b goes idle past the window; c now fits.
	later := now.Add(ViewerWindow + 2*time.Second)
	v.Admit("a", later.Add(-time.Second))
	if !v.Admit("c", later) {
		t.Fatal("slot of idle session not reclaimed")
	}
	if got := v.Count(later); got != 2 {
		t.Fatalf("count %d", got)
	}
	if NewViewers(0).Max() != 1 {
		t.Fatal("limit floor")
	}
}

func TestMaxViewers(t *testing.T) {
	cases := []struct {
		cap  int
		per  float64
		want int
	}{{200, 5, 40}, {201, 5, 40}, {4, 5, 1}, {100, 0, 20}, {1000, 2.5, 400}}
	for _, c := range cases {
		if got := MaxViewers(c.cap, c.per); got != c.want {
			t.Fatalf("MaxViewers(%d, %v) = %d, want %d", c.cap, c.per, got, c.want)
		}
	}
}

func TestMeterConverges(t *testing.T) {
	m := NewMeter(10 * time.Second)
	now := time.Unix(0, 0)
	var total int64
	m.Sample(total, now)
	// 10 Mbps = 1.25 MB/s, sampled every second for a minute.
	for range 60 {
		now = now.Add(time.Second)
		total += 1_250_000
		m.Sample(total, now)
	}
	if got := m.Mbps(); math.Abs(got-10) > 0.05 {
		t.Fatalf("EWMA %v, want ≈10", got)
	}
	// Idle for one time constant: decays to about 1/e.
	now = now.Add(10 * time.Second)
	m.Sample(total, now)
	if got := m.Mbps(); math.Abs(got-10/math.E) > 0.05 {
		t.Fatalf("after idle %v, want ≈%v", got, 10/math.E)
	}
	m.Sample(total, now) // zero dt ignored
}
