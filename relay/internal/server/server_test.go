// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/abolishus/commonair/relay/internal/accounting"
	"github.com/abolishus/commonair/relay/internal/cache"
	"github.com/abolishus/commonair/relay/internal/tokens"
)

// fakeRW accepts `okWrites` writes, then fails; flushErr makes every flush fail.
type fakeRW struct {
	header   http.Header
	okWrites int
	flushErr error
	written  int
}

func (f *fakeRW) Header() http.Header { return f.header }
func (f *fakeRW) WriteHeader(int)     {}
func (f *fakeRW) Write(b []byte) (int, error) {
	if f.okWrites == 0 {
		// A partial write, as when the peer resets mid-buffer.
		f.written += len(b) / 2
		return len(b) / 2, errors.New("broken pipe")
	}
	f.okWrites--
	f.written += len(b)
	return len(b), nil
}
func (f *fakeRW) FlushError() error { return f.flushErr }

func TestCountingWriterCountsOnlyDeliveredBytes(t *testing.T) {
	var counted int64
	rw := &fakeRW{header: http.Header{}, okWrites: 2}
	cw := &countingWriter{ResponseWriter: rw, rc: http.NewResponseController(rw), onBytes: func(n int64) { counted += n }}
	chunk := make([]byte, 1000)
	for range 2 {
		if _, err := cw.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := cw.Write(chunk); err == nil {
		t.Fatal("failed write not reported")
	}
	if _, err := cw.Write(chunk); err == nil {
		t.Fatal("write after failure must keep failing")
	}
	if counted != 2000 || cw.flushed != 2000 {
		t.Fatalf("counted %d, want 2000 (partial write must not be billed)", counted)
	}

	counted = 0
	rw = &fakeRW{header: http.Header{}, okWrites: 10, flushErr: errors.New("conn closed")}
	cw = &countingWriter{ResponseWriter: rw, rc: http.NewResponseController(rw), onBytes: func(n int64) { counted += n }}
	if _, err := cw.Write(chunk); err == nil || counted != 0 {
		t.Fatalf("unflushed bytes billed: %d", counted)
	}
}

type fixture struct {
	srv    *Server
	ledger *accounting.Ledger
	key    ed25519.PrivateKey
	ts     *httptest.Server
	origin *httptest.Server
}

const rid = "01890000-0000-7000-8000-0000000000aa"

func newFixture(t *testing.T, originHandler http.HandlerFunc, opts ...func(*Config)) *fixture {
	origin := httptest.NewServer(originHandler)
	t.Cleanup(origin.Close)
	pub, priv, _ := ed25519.GenerateKey(nil)
	ledger := accounting.NewLedger(time.Now())
	cfg := Config{
		Version: "test", PullToken: "relay_x", Store: cache.NewStore(64 << 20), Ledger: ledger,
		Viewers: accounting.NewViewers(10), Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaTimeout: 300 * time.Millisecond,
	}
	for _, o := range opts {
		o(&cfg)
	}
	s := New(cfg)
	pull, _ := url.Parse(origin.URL + "/relay-pull/")
	s.SetState(&State{RelayID: rid, PullBase: pull, OriginKey: pub, Status: "active"})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	t.Cleanup(s.Close)
	return &fixture{srv: s, ledger: ledger, key: priv, ts: ts, origin: origin}
}

func (f *fixture) token(sid string) string {
	now := time.Now().Unix()
	b, _ := json.Marshal(map[string]any{"v": 1, "sid": sid, "cid": rid, "path": "live/alice", "src": "relay", "rid": rid, "iat": now, "exp": now + 120})
	return tokens.EncodeB64URL(b) + "." + tokens.EncodeB64URL(ed25519.Sign(f.key, b))
}

func (f *fixture) do(t *testing.T, method, path string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, f.ts.URL+path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp
}

const sid1 = "01890000-0000-7000-8000-000000000001"

func TestMediaAccountingHeadAndRange(t *testing.T) {
	seg := strings.Repeat("s", 10_000)
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, seg) })
	tok := f.token(sid1)
	if resp := f.do(t, http.MethodHead, "/hls/live/alice/seg1.mp4?t="+tok, nil); resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "video/mp4" {
		t.Fatalf("HEAD %d %v", resp.StatusCode, resp.Header)
	}
	if resp := f.do(t, http.MethodGet, "/hls/live/alice/seg1.mp4?t="+tok, map[string]string{"Range": "bytes=0-99"}); resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("range %d", resp.StatusCode)
	}
	if resp := f.do(t, http.MethodGet, "/hls/live/alice/seg1.mp4?t="+tok, nil); resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") == "" {
		t.Fatalf("GET %d", resp.StatusCode)
	}
	// The handler books the segment after ServeContent returns, which can be after the client has
	// read the whole body: sum cuts until it shows up.
	var sids []string
	var bytes, segments int64
	for deadline := time.Now().Add(2 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		for _, e := range f.ledger.Cut(time.Now()).Entries {
			sids = append(sids, e.SessionID)
			bytes += e.Bytes
			segments += e.Segments
		}
		if segments >= 1 || time.Now().After(deadline) {
			break
		}
	}
	if len(slices.Compact(sids)) != 1 || bytes != 100+10_000 || segments != 1 {
		t.Fatalf("sids %v bytes %d segments %d: HEAD bills nothing, a range bills its bytes but no segment", sids, bytes, segments)
	}
}

func TestOriginFailuresMapToStatuses(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "forbidden.mp4"):
			w.WriteHeader(http.StatusForbidden)
		case strings.HasSuffix(r.URL.Path, "boom.mp4"):
			w.WriteHeader(http.StatusInternalServerError)
		case strings.HasSuffix(r.URL.Path, "slow.mp4"):
			time.Sleep(time.Second)
		case strings.HasSuffix(r.URL.Path, "index.m3u8"):
			_, _ = io.WriteString(w, "#EXTM3U\n#EXTINF:1,\n../../escape.mp4\n")
		default:
			http.NotFound(w, r)
		}
	})
	tok := f.token(sid1)
	cases := map[string]int{
		"gone.mp4":      http.StatusNotFound,
		"forbidden.mp4": http.StatusBadGateway,
		"boom.mp4":      http.StatusBadGateway,
		"slow.mp4":      http.StatusGatewayTimeout,
		"index.m3u8":    http.StatusBadGateway,
	}
	for name, want := range cases {
		if resp := f.do(t, http.MethodGet, "/hls/live/alice/"+name+"?t="+tok, nil); resp.StatusCode != want {
			t.Fatalf("%s: %d, want %d", name, resp.StatusCode, want)
		}
	}
	if p := f.ledger.Cut(time.Now()); len(p.Entries) != 0 {
		t.Fatalf("failures were billed: %+v", p.Entries)
	}
}

func TestHealthAndLifecycle(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {})
	get := func() (int, Health) {
		resp, err := http.Get(f.ts.URL + "/healthz")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var h Health
		_ = json.NewDecoder(resp.Body).Decode(&h)
		return resp.StatusCode, h
	}
	if code, h := get(); code != 200 || h.Status != "ok" || h.Version != "test" {
		t.Fatalf("%d %+v", code, h)
	}
	f.srv.SetState(nil)
	if code, h := get(); code != 200 || h.Status != "starting" {
		t.Fatalf("%d %+v", code, h)
	}
	if resp := f.do(t, http.MethodGet, "/hls/live/alice/x.mp4?t="+f.token(sid1), nil); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unregistered served: %d", resp.StatusCode)
	}
	f.srv.Drain()
	if code, h := get(); code != http.StatusServiceUnavailable || h.Status != "draining" {
		t.Fatalf("%d %+v", code, h)
	}
	if resp := f.do(t, http.MethodPost, "/hls/live/alice/x.mp4", nil); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST %d", resp.StatusCode)
	}
	if resp := f.do(t, http.MethodGet, "/other", nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown route %d", resp.StatusCode)
	}
}
