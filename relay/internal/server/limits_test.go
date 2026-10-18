// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// gate is an origin handler that holds requests until released.
type gate struct {
	release chan struct{}
	hits    atomic.Int32
	gone    atomic.Int32
}

func newGate() *gate { return &gate{release: make(chan struct{})} }

func (g *gate) handler(w http.ResponseWriter, r *http.Request) {
	g.hits.Add(1)
	select {
	case <-g.release:
		_, _ = io.WriteString(w, "media")
	case <-r.Context().Done():
		g.gone.Add(1)
	}
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func getStatus(url string, out chan<- int) {
	resp, err := http.Get(url)
	if err != nil {
		out <- 0
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	out <- resp.StatusCode
}

func TestOriginFetchBudgetReturns503(t *testing.T) {
	g := newGate()
	f := newFixture(t, g.handler, func(c *Config) { c.MaxOriginFetches = 2; c.MediaTimeout = 5 * time.Second })
	results := make(chan int, 2)
	for i := range 2 {
		sid := fmt.Sprintf("01890000-0000-7000-8000-00000000010%d", i)
		go getStatus(fmt.Sprintf("%s/hls/live/alice/seg%d.mp4?t=%s", f.ts.URL, i, f.token(sid)), results)
	}
	waitUntil(t, "two origin fetches in flight", func() bool { return g.hits.Load() == 2 })
	resp := f.do(t, http.MethodGet, "/hls/live/alice/seg9.mp4?t="+f.token(sid1), nil)
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("third distinct fetch: %d, want 503", resp.StatusCode)
	}
	if g.hits.Load() != 2 {
		t.Fatal("over-budget request reached the origin")
	}
	close(g.release)
	for range 2 {
		if code := <-results; code != http.StatusOK {
			t.Fatalf("in-budget fetch: %d", code)
		}
	}
	if resp := f.do(t, http.MethodGet, "/hls/live/alice/seg9.mp4?t="+f.token(sid1), nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("slots not released: %d", resp.StatusCode)
	}
}

func TestPerSessionConcurrencyCap(t *testing.T) {
	g := newGate()
	f := newFixture(t, g.handler, func(c *Config) { c.MaxRequestsPerSession = 2; c.MediaTimeout = 5 * time.Second })
	tok := f.token(sid1)
	done := make(chan int, 2)
	for i := range 2 {
		go getStatus(fmt.Sprintf("%s/hls/live/alice/p%d.mp4?t=%s", f.ts.URL, i, tok), done)
	}
	waitUntil(t, "two requests held", func() bool { return g.hits.Load() == 2 })
	if resp := f.do(t, http.MethodGet, "/hls/live/alice/p9.mp4?t="+tok, nil); resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("third concurrent request for one session: %d, want 429", resp.StatusCode)
	}
	close(g.release)
	for range 2 {
		<-done
	}
	other := f.token("01890000-0000-7000-8000-000000000002")
	if resp := f.do(t, http.MethodGet, "/hls/live/alice/p9.mp4?t="+other, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("other session: %d", resp.StatusCode)
	}
	if resp := f.do(t, http.MethodGet, "/hls/live/alice/p8.mp4?t="+tok, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("session slots not released: %d", resp.StatusCode)
	}
}

func TestAbandonedFetchIsCancelledAtOrigin(t *testing.T) {
	g := newGate()
	f := newFixture(t, g.handler, func(c *Config) { c.MediaTimeout = 10 * time.Second })
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, f.ts.URL+"/hls/live/alice/hint.mp4?t="+f.token(sid1), nil)
	errc := make(chan error, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		errc <- err
	}()
	waitUntil(t, "origin fetch", func() bool { return g.hits.Load() == 1 })
	cancel()
	<-errc
	waitUntil(t, "origin request cancelled after the only viewer left", func() bool { return g.gone.Load() == 1 })
}

func TestWaitIdle(t *testing.T) {
	g := newGate()
	f := newFixture(t, g.handler, func(c *Config) { c.MediaTimeout = 5 * time.Second })
	done := make(chan int, 1)
	go getStatus(f.ts.URL+"/hls/live/alice/x.mp4?t="+f.token(sid1), done)
	waitUntil(t, "handler running", func() bool { return g.hits.Load() == 1 })
	short, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := f.srv.WaitIdle(short); err == nil {
		t.Fatal("idle while a handler was running")
	}
	close(g.release)
	if err := f.srv.WaitIdle(context.Background()); err != nil {
		t.Fatal(err)
	}
	<-done
}
