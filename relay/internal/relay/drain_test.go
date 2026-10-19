// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package relay

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/abolishus/commonair/relay/internal/apiclient"
)

func (a *fakeAPI) beats() []apiclient.HeartbeatRequest {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]apiclient.HeartbeatRequest(nil), a.heartbeats...)
}

func TestClassifyHeartbeat(t *testing.T) {
	apiErr := func(status int) error { return &apiclient.Error{Status: status, Code: "X"} }
	cases := []struct {
		name string
		resp apiclient.HeartbeatResponse
		err  error
		want hbAction
	}{
		{"active", apiclient.HeartbeatResponse{Status: "active"}, nil, hbApply},
		{"pending", apiclient.HeartbeatResponse{Status: "pending"}, nil, hbApply},
		{"degraded", apiclient.HeartbeatResponse{Status: "degraded"}, nil, hbApply},
		{"suspended keeps running", apiclient.HeartbeatResponse{Status: "suspended"}, nil, hbApply},
		{"offline re-registers", apiclient.HeartbeatResponse{Status: "offline"}, nil, hbReregister},
		{"401 re-registers", apiclient.HeartbeatResponse{}, apiErr(http.StatusUnauthorized), hbReregister},
		{"404 re-registers", apiclient.HeartbeatResponse{}, apiErr(http.StatusNotFound), hbReregister},
		{"412 not registered", apiclient.HeartbeatResponse{}, apiErr(http.StatusPreconditionFailed), hbReregister},
		{"400 retries", apiclient.HeartbeatResponse{}, apiErr(http.StatusBadRequest), hbRetry},
		{"429 retries", apiclient.HeartbeatResponse{}, apiErr(http.StatusTooManyRequests), hbRetry},
		{"500 retries", apiclient.HeartbeatResponse{}, apiErr(http.StatusInternalServerError), hbRetry},
		{"503 retries", apiclient.HeartbeatResponse{}, apiErr(http.StatusServiceUnavailable), hbRetry},
		{"network error retries", apiclient.HeartbeatResponse{}, errors.New("dial tcp: connection refused"), hbRetry},
		{"timeout retries", apiclient.HeartbeatResponse{}, context.DeadlineExceeded, hbRetry},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := classifyHeartbeat(c.resp, c.err); got != c.want {
				t.Fatalf("classifyHeartbeat = %d, want %d", got, c.want)
			}
		})
	}
}

func TestOfflineHeartbeatReregistersWithSameKey(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)
	defer rel.Shutdown(context.Background())
	h.api.mu.Lock()
	firstKey := h.api.relayPub
	h.api.mu.Unlock()
	// The worker timed the relay out (it was paused): heartbeats say offline.
	// Registration flips it back to active.
	h.api.set(func(a *fakeAPI) { a.status = "offline" })
	h.eventually("re-registration after offline", func() bool {
		h.api.mu.Lock()
		defer h.api.mu.Unlock()
		if h.api.registrations >= 2 {
			h.api.status = "active"
			return true
		}
		return false
	})
	h.api.mu.Lock()
	key := h.api.relayPub
	h.api.mu.Unlock()
	if key != firstKey {
		t.Fatal("re-registration changed the relay key")
	}
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+h.token(sid(1))); status != http.StatusOK {
		t.Fatalf("serving after re-registration: %d", status)
	}
}

func TestOtherHeartbeatErrorsKeepState(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)
	defer rel.Shutdown(context.Background())
	h.api.set(func(a *fakeAPI) { a.heartbeatFail = http.StatusServiceUnavailable })
	time.Sleep(200 * time.Millisecond) // several heartbeat intervals
	h.api.mu.Lock()
	regs := h.api.registrations
	h.api.mu.Unlock()
	if regs != 1 {
		t.Fatalf("a 503 heartbeat triggered %d registrations", regs)
	}
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+h.token(sid(1))); status != http.StatusOK {
		t.Fatalf("a failing API stopped serving: %d", status)
	}
}

func TestGracefulStopSendsOneDrainingHeartbeat(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)
	h.eventually("normal heartbeats", func() bool { return len(h.api.beats()) >= 2 })
	for _, b := range h.api.beats() {
		if b.Draining {
			t.Fatal("draining heartbeat before shutdown")
		}
	}
	// A viewer watches before and during the drain.
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+h.token(sid(7))); status != http.StatusOK {
		t.Fatalf("before drain: %d", status)
	}
	stopped := make(chan error, 1)
	go func() { stopped <- rel.GracefulStop(h.relaySrv.Config, 600*time.Millisecond, 2*time.Second) }()
	h.eventually("draining heartbeat", func() bool {
		b := h.api.beats()
		return len(b) > 0 && b[len(b)-1].Draining
	})
	// The current viewer keeps being served during the drain; new ones are not.
	status, _, _ := h.get(t, "/hls/live/alice/seg2.mp4?t="+h.token(sid(7)))
	if status != http.StatusOK {
		t.Fatalf("current viewer during drain: %d", status)
	}
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+h.token(sid(8))); status != http.StatusServiceUnavailable {
		t.Fatalf("new viewer during drain: %d", status)
	}
	if st := h.health(); st.Status != "draining" {
		t.Fatalf("health during drain %+v", st)
	}
	if err := <-stopped; err != nil {
		t.Fatalf("graceful stop: %v", err)
	}
	beats := h.api.beats()
	drainAt := -1
	for i, b := range beats {
		if b.Draining {
			if drainAt >= 0 {
				t.Fatal("more than one draining heartbeat")
			}
			drainAt = i
		}
	}
	if drainAt != len(beats)-1 {
		t.Fatalf("normal heartbeats after the draining one: %+v", beats[drainAt:])
	}
	if beats[drainAt].ActiveViewers != 1 {
		t.Fatalf("draining heartbeat viewers %d", beats[drainAt].ActiveViewers)
	}
	// Receipts cover the drain period: segment 2 was served after the drain began.
	bytes, segments := h.api.receiptTotals(t)
	if segments[sid(7)] != 2 || bytes[sid(7)] != int64(media["seg1.mp4"]+media["seg2.mp4"]) {
		t.Fatalf("drain-period bytes missing from receipts: %d bytes / %d segments", bytes[sid(7)], segments[sid(7)])
	}
	if bytes[sid(8)] != 0 {
		t.Fatal("refused viewer was counted")
	}
}

func TestDrainingHeartbeatFailureDoesNotBlockShutdown(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)
	h.api.set(func(a *fakeAPI) { a.heartbeatFail = http.StatusInternalServerError })
	start := time.Now()
	if err := rel.GracefulStop(h.relaySrv.Config, 300*time.Millisecond, 2*time.Second); err != nil {
		t.Fatalf("graceful stop: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("stop took %v", elapsed)
	}
}

func TestDrainBeforeRegistrationStopsRetrying(t *testing.T) {
	h := newHarness(t)
	h.api.set(func(a *fakeAPI) { a.allFail = http.StatusServiceUnavailable })
	rel, err := New(Options{
		APIURL: h.api.URL, Token: relayToken, PublicURL: h.relaySrv.URL, CapacityMbps: 10,
		DataDir: h.dataDir, CacheBytes: 16 << 20, Version: "test", Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		RetryMin: 10 * time.Millisecond, RetryMax: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.handler.Store(rel.Handler())
	rel.Start()
	time.Sleep(50 * time.Millisecond)
	done := make(chan error, 1)
	go func() { done <- rel.GracefulStop(h.relaySrv.Config, 200*time.Millisecond, time.Second) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown hung while registration was failing")
	}
}

// A blackholed API must not delay the drain: the call in flight at SIGTERM
// (a normal heartbeat, or a re-registration after offline) gives way, the
// draining heartbeat goes out at once and shutdown keeps to drain+flush.
func TestDrainNotDelayedByHangingAPICall(t *testing.T) {
	for name, setup := range map[string]func(a *fakeAPI){
		"heartbeat": func(a *fakeAPI) { a.hangPaths.Store("/api/relay/heartbeat", true) },
		"re-registration": func(a *fakeAPI) {
			a.hangPaths.Store("/api/relay/register", true)
			a.status = "offline"
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			rel := h.start(200)
			h.api.set(setup)
			h.eventually("API call hanging", func() bool { return h.api.hanging.Load() > 0 })
			const drain, flush = 600 * time.Millisecond, 2 * time.Second
			start := time.Now()
			stopped := make(chan error, 1)
			go func() { stopped <- rel.GracefulStop(h.relaySrv.Config, drain, flush) }()
			deadline := start.Add(5 * time.Second)
			for {
				b := h.api.beats()
				if len(b) > 0 && b[len(b)-1].Draining {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("no draining heartbeat")
				}
				time.Sleep(2 * time.Millisecond)
			}
			if took := time.Since(start); took > 100*time.Millisecond {
				t.Fatalf("draining heartbeat after %v", took)
			}
			if err := <-stopped; err != nil {
				t.Fatalf("graceful stop: %v", err)
			}
			if took := time.Since(start); took > drain+flush {
				t.Fatalf("shutdown took %v", took)
			}
		})
	}
}
