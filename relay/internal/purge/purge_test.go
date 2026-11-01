// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package purge

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/abolishus/commonair/relay/internal/tokens"
)

type vectors struct {
	PublicKey string `json:"publicKey"`
	Purge     struct {
		Signed tokens.SignedPurgeBatch `json:"signed"`
		Cases  []struct {
			Name   string                  `json:"name"`
			Signed tokens.SignedPurgeBatch `json:"signed"`
			Error  *string                 `json:"error"`
		} `json:"cases"`
	} `json:"purge"`
}

func loadVectors(t *testing.T) (vectors, ed25519.PublicKey) {
	t.Helper()
	raw, err := os.ReadFile("../../../packages/tokens/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	pub, err := tokens.ParsePublicKey(v.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return v, pub
}

// recorder is a Target that remembers what it was told.
type recorder struct {
	mu       sync.Mutex
	prefixes []string
	all      int
}

func (r *recorder) PurgePrefix(p string) {
	r.mu.Lock()
	r.prefixes = append(r.prefixes, p)
	r.mu.Unlock()
}
func (r *recorder) PurgeAll() { r.mu.Lock(); r.all++; r.mu.Unlock() }
func (r *recorder) snapshot() ([]string, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.prefixes...), r.all
}

// fakeAPI answers each poll from a queue; an empty queue blocks until ctx ends.
type fakeAPI struct {
	mu      sync.Mutex
	answers []answer
	afters  []int64
	polled  chan int64
}

type answer struct {
	signed tokens.SignedPurgeBatch
	err    error
}

func (f *fakeAPI) Purges(ctx context.Context, after int64) (tokens.SignedPurgeBatch, error) {
	f.mu.Lock()
	f.afters = append(f.afters, after)
	var a *answer
	if len(f.answers) > 0 {
		a = &f.answers[0]
		f.answers = f.answers[1:]
	}
	f.mu.Unlock()
	if f.polled != nil {
		f.polled <- after
	}
	if a == nil {
		<-ctx.Done()
		return tokens.SignedPurgeBatch{}, ctx.Err()
	}
	return a.signed, a.err
}

func (f *fakeAPI) calls() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int64(nil), f.afters...)
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func sign(t *testing.T, priv ed25519.PrivateKey, b tokens.PurgeBatch) tokens.SignedPurgeBatch {
	t.Helper()
	s, err := tokens.SignPurgeBatch(priv, b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestPollAppliesTheVectorBatch(t *testing.T) {
	v, pub := loadVectors(t)
	target := &recorder{}
	l := &Loop{API: &fakeAPI{answers: []answer{{signed: v.Purge.Signed}}}, Target: target, Log: quiet()}
	changed, err := l.Poll(context.Background(), pub)
	if err != nil || !changed {
		t.Fatalf("poll: %v %v", changed, err)
	}
	got, all := target.snapshot()
	want := []string{"dvr/01890000-0000-7000-8000-000000000009/", "live/alice/", "live/alice/captions/"}
	if all != 0 || len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("applied %v (all %d)", got, all)
	}
	if l.Seq() != 42 || l.Applied() != 3 {
		t.Fatalf("seq %d applied %d", l.Seq(), l.Applied())
	}
	// vod_removed is not a RELAY_PURGE_REASONS value: applied, and counted as unknown.
	if l.UnknownReasons() != 1 {
		t.Fatalf("unknown reasons %d", l.UnknownReasons())
	}
}

// Every vector case is applied or refused exactly as the shared vectors say.
func TestPollVectorCases(t *testing.T) {
	v, pub := loadVectors(t)
	if len(v.Purge.Cases) == 0 {
		t.Fatal("no purge cases")
	}
	for _, c := range v.Purge.Cases {
		t.Run(c.Name, func(t *testing.T) {
			target := &recorder{}
			l := &Loop{API: &fakeAPI{answers: []answer{{signed: c.Signed}}}, Target: target, Log: quiet()}
			l.seq.Store(7)
			_, err := l.Poll(context.Background(), pub)
			got, all := target.snapshot()
			if c.Error != nil {
				if !errors.Is(err, errRefused) || l.Refused() != 1 || len(got) != 0 || all != 0 || l.Seq() != 7 {
					t.Fatalf("want refused (%s): err %v, refused %d, applied %v/%d, seq %d", *c.Error, err, l.Refused(), got, all, l.Seq())
				}
				return
			}
			if err != nil || l.Refused() != 0 {
				t.Fatalf("want applied: %v", err)
			}
		})
	}
}

func TestPollRefusesTamperedAndWrongKey(t *testing.T) {
	pub, priv := newKey(t)
	otherPub, _ := newKey(t)
	good := sign(t, priv, tokens.PurgeBatch{Seq: 5, Items: []tokens.PurgeItem{{Seq: 5, Prefix: "dvr/x/", Reason: "vod_hidden"}}})
	tampered := good
	other := sign(t, priv, tokens.PurgeBatch{Seq: 9, Items: []tokens.PurgeItem{{Seq: 9, Prefix: "live/bob/", Reason: "suspended"}}})
	tampered.Payload = other.Payload // a valid payload under another batch's signature

	for name, tc := range map[string]struct {
		signed tokens.SignedPurgeBatch
		key    ed25519.PublicKey
	}{
		"tampered":  {tampered, pub},
		"wrong key": {good, otherPub},
		"garbage":   {tokens.SignedPurgeBatch{Payload: "!!", Signature: "??"}, pub},
	} {
		t.Run(name, func(t *testing.T) {
			target := &recorder{}
			l := &Loop{API: &fakeAPI{answers: []answer{{signed: tc.signed}}}, Target: target, Log: quiet()}
			if _, err := l.Poll(context.Background(), tc.key); !errors.Is(err, errRefused) {
				t.Fatalf("err %v", err)
			}
			if got, all := target.snapshot(); len(got) != 0 || all != 0 || l.Seq() != 0 || l.Refused() != 1 {
				t.Fatalf("applied %v %d seq %d", got, all, l.Seq())
			}
		})
	}
}

func TestPollReset(t *testing.T) {
	pub, priv := newKey(t)
	target := &recorder{}
	l := &Loop{API: &fakeAPI{answers: []answer{{signed: sign(t, priv, tokens.PurgeBatch{Seq: 900, Reset: true})}}}, Target: target, Log: quiet()}
	l.seq.Store(3)
	if _, err := l.Poll(context.Background(), pub); err != nil {
		t.Fatal(err)
	}
	if _, all := target.snapshot(); all != 1 || l.Seq() != 900 || l.Resets() != 1 {
		t.Fatalf("all %d seq %d", all, l.Seq())
	}
}

func TestCursorPersistsInTheStateDir(t *testing.T) {
	dir := t.TempDir()
	pub, priv := newKey(t)
	l := &Loop{
		API:    &fakeAPI{answers: []answer{{signed: sign(t, priv, tokens.PurgeBatch{Seq: 77, Items: []tokens.PurgeItem{{Seq: 77, Prefix: "dvr/v/", Reason: "recording_ended"}}})}}},
		Target: &recorder{}, Dir: dir, Log: quiet(),
	}
	l.Load()
	if l.Seq() != 0 {
		t.Fatal("fresh state should start at 0")
	}
	if _, err := l.Poll(context.Background(), pub); err != nil {
		t.Fatal(err)
	}
	again := &Loop{Dir: dir, Log: quiet()}
	again.Load()
	if again.Seq() != 77 {
		t.Fatalf("reloaded seq %d", again.Seq())
	}
	if err := os.WriteFile(filepath.Join(dir, StateFile), []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	corrupt := &Loop{Dir: dir, Log: quiet()}
	corrupt.Load()
	if corrupt.Seq() != 0 {
		t.Fatal("a corrupt cursor should start from 0")
	}
	// Memory only: no file is written.
	mem := &Loop{API: &fakeAPI{answers: []answer{{signed: sign(t, priv, tokens.PurgeBatch{Seq: 3, Items: []tokens.PurgeItem{{Seq: 3, Prefix: "dvr/v/", Reason: "vod_hidden"}}})}}}, Target: &recorder{}, Log: quiet()}
	if _, err := mem.Poll(context.Background(), pub); err != nil || mem.Seq() != 3 {
		t.Fatalf("%v %d", err, mem.Seq())
	}
}

// The loop waits for registration, follows the cursor, backs off (doubling,
// capped) on failures and refused batches, and resets the backoff on success.
func TestRunBacksOffAndFollowsTheCursor(t *testing.T) {
	pub, priv := newKey(t)
	api := &fakeAPI{answers: []answer{
		{err: errors.New("connection refused")},
		{err: errors.New("connection refused")},
		{signed: tokens.SignedPurgeBatch{Payload: "e30", Signature: "bad"}},
		{signed: sign(t, priv, tokens.PurgeBatch{Seq: 4, Items: []tokens.PurgeItem{{Seq: 4, Prefix: "live/a/", Reason: "restricted"}}})},
		{err: errors.New("503")},
		{signed: sign(t, priv, tokens.PurgeBatch{Seq: 4})},
	}}
	var keyMu sync.Mutex
	var key ed25519.PublicKey
	var sleeps []time.Duration
	var sleepMu sync.Mutex
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	target := &recorder{}
	l := &Loop{
		API: api, Target: target, Log: quiet(),
		Key:        func() ed25519.PublicKey { keyMu.Lock(); defer keyMu.Unlock(); return key },
		MinBackoff: 100 * time.Millisecond, MaxBackoff: 250 * time.Millisecond, MinInterval: time.Second,
		Sleep: func(ctx context.Context, d time.Duration) bool {
			sleepMu.Lock()
			sleeps = append(sleeps, d)
			n := len(sleeps)
			sleepMu.Unlock()
			if n == 1 {
				// The first wait is for registration: register now.
				keyMu.Lock()
				key = pub
				keyMu.Unlock()
			}
			return ctx.Err() == nil
		},
	}
	done := make(chan struct{})
	go func() { l.Run(ctx); close(done) }()
	deadline := time.After(5 * time.Second)
	for len(api.calls()) < 7 {
		select {
		case <-deadline:
			t.Fatalf("polls %v", api.calls())
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	<-done
	calls := api.calls()
	want := []int64{0, 0, 0, 0, 4, 4, 4}
	for i, w := range want {
		if calls[i] != w {
			t.Fatalf("afters %v, want prefix %v", calls, want)
		}
	}
	sleepMu.Lock()
	defer sleepMu.Unlock()
	// sleeps: registration wait, 3 backoffs (100, 200, 250 capped; ±20 %), then after the
	// success a fresh 100 ms backoff for the 503, then the min interval after an empty batch.
	if len(sleeps) < 6 || sleeps[0] != 100*time.Millisecond {
		t.Fatalf("sleeps %v", sleeps)
	}
	within := func(d, base time.Duration) bool {
		return d >= time.Duration(float64(base)*0.8) && d <= time.Duration(float64(base)*1.2)
	}
	if !within(sleeps[1], 100*time.Millisecond) || !within(sleeps[2], 200*time.Millisecond) || !within(sleeps[3], 250*time.Millisecond) {
		t.Fatalf("backoff did not double and cap: %v", sleeps)
	}
	if !within(sleeps[4], 100*time.Millisecond) {
		t.Fatalf("backoff not reset after success: %v", sleeps)
	}
	if sleeps[5] <= 900*time.Millisecond || sleeps[5] > time.Second {
		t.Fatalf("an empty answer should wait out the min interval: %v", sleeps)
	}
	if got, _ := target.snapshot(); len(got) != 1 || got[0] != "live/a/" || l.Refused() != 1 {
		t.Fatalf("applied %v refused %d", got, l.Refused())
	}
}

func TestRunStopsWithItsContext(t *testing.T) {
	pub, _ := newKey(t)
	api := &fakeAPI{polled: make(chan int64, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	l := &Loop{API: api, Target: &recorder{}, Log: quiet(), Key: func() ed25519.PublicKey { return pub }}
	done := make(chan struct{})
	go func() { l.Run(ctx); close(done) }()
	<-api.polled
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return")
	}
}
