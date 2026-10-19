// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package relay

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/abolishus/commonair/relay/internal/apiclient"
	"github.com/abolishus/commonair/relay/internal/server"
	"github.com/abolishus/commonair/relay/internal/tokens"
)

const (
	relayToken = "relay_test_token"
	relayID    = "01890000-0000-7000-8000-0000000000aa"
	channelID  = "01890000-0000-7000-8000-0000000000cc"
)

var media = map[string]int{
	"init.mp4":       1_000,
	"seg1.mp4":       200_000,
	"seg2.mp4":       150_000,
	"seg3_part0.mp4": 30_000,
	"seg3_part1.mp4": 20_000,
}

const originPlaylist = "#EXTM3U\n" +
	"#EXT-X-VERSION:9\n" +
	"#EXT-X-TARGETDURATION:1\n" +
	"#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.6\n" +
	"#EXT-X-PART-INF:PART-TARGET=0.2\n" +
	"#EXT-X-MEDIA-SEQUENCE:1\n" +
	"#EXT-X-MAP:URI=\"init.mp4\"\n" +
	"#EXTINF:1.0,\nseg1.mp4\n" +
	"#EXTINF:1.0,\nseg2.mp4\n" +
	"#EXT-X-PART:DURATION=0.2,URI=\"seg3_part0.mp4\",INDEPENDENT=YES\n" +
	"#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"seg3_part1.mp4\"\n"

func mediaBody(name string) []byte {
	b := make([]byte, media[name])
	for i := range b {
		b[i] = byte(i*7 + len(name))
	}
	return b
}

// fakeOrigin serves relay-pull for live/alice.
type fakeOrigin struct {
	*httptest.Server
	mu      sync.Mutex
	hits    map[string]int
	queries []string
	slow    time.Duration
}

func newFakeOrigin(t *testing.T) *fakeOrigin {
	o := &fakeOrigin{hits: map[string]int{}}
	o.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+relayToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		name, ok := strings.CutPrefix(r.URL.Path, "/relay-pull/live/alice/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		o.mu.Lock()
		o.hits[name]++
		if name == "index.m3u8" {
			o.queries = append(o.queries, r.URL.RawQuery)
		}
		slow := o.slow
		o.mu.Unlock()
		if slow > 0 {
			time.Sleep(slow)
		}
		if name == "index.m3u8" {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = io.WriteString(w, originPlaylist)
			return
		}
		if name == "big.mp4" {
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(make([]byte, bigBytes))
			return
		}
		if _, ok := media[name]; !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(mediaBody(name))
	}))
	t.Cleanup(o.Close)
	return o
}

func (o *fakeOrigin) hitCount(name string) int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.hits[name]
}

// fakeAPI implements the relay protocol endpoints.
type fakeAPI struct {
	*httptest.Server
	originURL string
	originKey ed25519.PublicKey

	mu            sync.Mutex
	relayPub      string
	registrations int
	heartbeats    []apiclient.HeartbeatRequest
	receipts      []tokens.SignedReceipt
	status        string
	receiptStatus int // non-zero: fail receipts with this status
	unknownOnce   bool
	heartbeatFail int // non-zero: fail heartbeats with this status
	allFail       int // non-zero: fail every call with this status
}

func newFakeAPI(t *testing.T, originURL string, originKey ed25519.PublicKey) *fakeAPI {
	a := &fakeAPI{originURL: originURL, originKey: originKey, status: "active"}
	a.Server = httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(a.Close)
	return a
}

func (a *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+relayToken {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"code": "UNAUTHORIZED", "message": "bad token"})
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.allFail != 0 {
		writeJSON(w, a.allFail, map[string]any{"code": "UNAVAILABLE"})
		return
	}
	switch r.URL.Path {
	case "/api/relay/register":
		var in apiclient.RegisterRequest
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || len(in.PublicKey) != 43 || in.DeclaredCapacityMbps < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"code": "BAD_REQUEST"})
			return
		}
		a.relayPub = in.PublicKey
		a.registrations++
		writeJSON(w, http.StatusOK, apiclient.RegisterResponse{
			RelayID: relayID, OriginURL: a.originURL, OriginPublicKey: tokens.EncodeB64URL(a.originKey),
			ReceiptIntervalSeconds: 60, HeartbeatIntervalSeconds: 15, Status: a.status,
		})
	case "/api/relay/heartbeat":
		if a.unknownOnce {
			a.unknownOnce = false
			writeJSON(w, http.StatusUnauthorized, map[string]any{"code": "UNAUTHORIZED"})
			return
		}
		if a.heartbeatFail != 0 {
			writeJSON(w, a.heartbeatFail, map[string]any{"code": "UNAVAILABLE"})
			return
		}
		var in apiclient.HeartbeatRequest
		_ = json.NewDecoder(r.Body).Decode(&in)
		a.heartbeats = append(a.heartbeats, in)
		writeJSON(w, http.StatusOK, apiclient.HeartbeatResponse{Status: a.status, OriginPublicKey: tokens.EncodeB64URL(a.originKey)})
	case "/api/relay/receipts":
		if a.receiptStatus != 0 {
			writeJSON(w, a.receiptStatus, map[string]any{"code": "UNAVAILABLE"})
			return
		}
		var in tokens.SignedReceipt
		_ = json.NewDecoder(r.Body).Decode(&in)
		a.receipts = append(a.receipts, in)
		writeJSON(w, http.StatusOK, apiclient.ReceiptResponse{ReceiptID: "01890000-0000-7000-8000-0000000000ee", Status: "pending"})
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"code": "NOT_FOUND"})
	}
}

func (a *fakeAPI) set(f func(a *fakeAPI)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f(a)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// receiptTotals verifies every received receipt and sums it per session.
func (a *fakeAPI) receiptTotals(t *testing.T) (bytes, segments map[string]int64) {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	pubRaw, err := tokens.DecodeB64URL(a.relayPub)
	if err != nil {
		t.Fatal(err)
	}
	bytes, segments = map[string]int64{}, map[string]int64{}
	nonces := map[string]bool{}
	for _, r := range a.receipts {
		payload, ok := tokens.VerifyReceipt(ed25519.PublicKey(pubRaw), r)
		if !ok {
			t.Fatal("receipt signature does not verify with the registered key")
		}
		var p tokens.ReceiptPayload
		if err := json.Unmarshal(payload, &p); err != nil {
			t.Fatal(err)
		}
		if p.V != 1 || p.RelayID != relayID || len(p.Nonce) < 16 || nonces[p.Nonce] {
			t.Fatalf("bad payload %+v", p)
		}
		nonces[p.Nonce] = true
		start, err1 := time.Parse(time.RFC3339Nano, p.PeriodStart)
		end, err2 := time.Parse(time.RFC3339Nano, p.PeriodEnd)
		if err1 != nil || err2 != nil || end.Before(start) {
			t.Fatalf("bad period %s..%s", p.PeriodStart, p.PeriodEnd)
		}
		for _, e := range p.Entries {
			bytes[e.SessionID] += e.Bytes
			segments[e.SessionID] += e.Segments
		}
	}
	return bytes, segments
}

type harness struct {
	t         *testing.T
	originPub ed25519.PublicKey
	originKey ed25519.PrivateKey
	origin    *fakeOrigin
	api       *fakeAPI
	relaySrv  *httptest.Server
	handler   atomic.Value
	dataDir   string
}

func newHarness(t *testing.T) *harness {
	pub, priv, _ := ed25519.GenerateKey(nil)
	h := &harness{t: t, originPub: pub, originKey: priv, dataDir: t.TempDir()}
	h.origin = newFakeOrigin(t)
	h.api = newFakeAPI(t, h.origin.URL+"/", pub)
	h.relaySrv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.handler.Load().(http.Handler).ServeHTTP(w, r)
	}))
	t.Cleanup(h.relaySrv.Close)
	return h
}

func (h *harness) start(capacity int) *Relay {
	h.t.Helper()
	rel, err := New(Options{
		APIURL: h.api.URL, Token: relayToken, PublicURL: h.relaySrv.URL, CapacityMbps: capacity,
		DataDir: h.dataDir, CacheBytes: 64 << 20, Version: "test",
		Log:             slog.New(slog.NewJSONHandler(io.Discard, nil)),
		ReceiptInterval: 150 * time.Millisecond, HeartbeatInterval: 50 * time.Millisecond,
		RetryMin: 10 * time.Millisecond, RetryMax: 50 * time.Millisecond,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	h.handler.Store(rel.Handler())
	rel.Start()
	h.eventually("registered", func() bool { return h.health().Status == "ok" || h.health().Status == "suspended" })
	return rel
}

func (h *harness) health() server.Health {
	resp, err := http.Get(h.relaySrv.URL + "/healthz")
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out server.Health
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out
}

func (h *harness) eventually(what string, cond func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type claimOpt func(m map[string]any)

func (h *harness) token(sid string, opts ...claimOpt) string {
	now := time.Now().Unix()
	m := map[string]any{"v": 1, "sid": sid, "cid": channelID, "path": "live/alice", "src": "relay", "rid": relayID, "iat": now, "exp": now + 120}
	for _, o := range opts {
		o(m)
	}
	b, _ := json.Marshal(m)
	return tokens.EncodeB64URL(b) + "." + tokens.EncodeB64URL(ed25519.Sign(h.originKey, b))
}

func (h *harness) fetch(path string) (int, []byte, http.Header, error) {
	resp, err := http.Get(h.relaySrv.URL + path)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return resp.StatusCode, body, resp.Header, err
}

func (h *harness) get(t testing.TB, path string) (int, []byte, http.Header) {
	t.Helper()
	status, body, hdr, err := h.fetch(path)
	if err != nil {
		t.Fatal(err)
	}
	return status, body, hdr
}

// watch plays the stream as a viewer: playlist, then every media URI in it.
// It returns the media bytes and objects received. Safe to call from any goroutine.
func (h *harness) watch(sid string) (bytes int64, objects int64, err error) {
	tok := h.token(sid)
	plURL := "/hls/live/alice/index.m3u8?t=" + url.QueryEscape(tok)
	status, body, hdr, err := h.fetch(plURL)
	if err != nil {
		return 0, 0, err
	}
	if status != http.StatusOK {
		return 0, 0, fmt.Errorf("playlist status %d: %s", status, body)
	}
	if hdr.Get("Access-Control-Allow-Origin") != "*" || hdr.Get("Content-Type") != "application/vnd.apple.mpegurl" {
		return 0, 0, fmt.Errorf("playlist headers %v", hdr)
	}
	uris, err := mediaURIs(string(body))
	if err != nil {
		return 0, 0, err
	}
	base, _ := url.Parse(h.relaySrv.URL + plURL)
	for _, u := range uris {
		ref, err := url.Parse(u)
		if err != nil {
			return 0, 0, err
		}
		if ref.Query().Get("t") != tok || ref.IsAbs() {
			return 0, 0, fmt.Errorf("URI %q not relative with the viewer token", u)
		}
		abs := base.ResolveReference(ref)
		status, data, _, err := h.fetch(abs.RequestURI())
		if err != nil {
			return 0, 0, err
		}
		name := strings.TrimPrefix(abs.Path, "/hls/live/alice/")
		if status != http.StatusOK || string(data) != string(mediaBody(name)) {
			return 0, 0, fmt.Errorf("%s: status %d, %d bytes", name, status, len(data))
		}
		bytes += int64(len(data))
		objects++
	}
	return bytes, objects, nil
}

func (h *harness) mustWatch(t testing.TB, sid string) (int64, int64) {
	t.Helper()
	b, n, err := h.watch(sid)
	if err != nil {
		t.Fatal(err)
	}
	return b, n
}

func mediaURIs(playlist string) ([]string, error) {
	var out []string
	sc := bufio.NewScanner(strings.NewReader(playlist))
	for sc.Scan() {
		line := sc.Text()
		if i := strings.Index(line, `URI="`); i >= 0 {
			rest := line[i+5:]
			out = append(out, rest[:strings.IndexByte(rest, '"')])
		} else if line != "" && !strings.HasPrefix(line, "#") {
			out = append(out, line)
		}
	}
	if len(out) != len(media) {
		return nil, fmt.Errorf("found %d URIs, want %d:\n%s", len(out), len(media), playlist)
	}
	return out, nil
}

func sid(n int) string { return fmt.Sprintf("01890000-0000-7000-8000-%012d", n) }

func TestEndToEndServesAndReceiptsMatchBytes(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)

	served := map[string]int64{}
	objects := map[string]int64{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 1; i <= 4; i++ {
		wg.Go(func() {
			b, n, err := h.watch(sid(i))
			if err != nil {
				t.Error(err)
			}
			mu.Lock()
			served[sid(i)] += b
			objects[sid(i)] += n
			mu.Unlock()
		})
	}
	wg.Wait()
	// A second pass by one viewer is served from cache.
	b, n := h.mustWatch(t, sid(1))
	served[sid(1)] += b
	objects[sid(1)] += n
	for name := range media {
		if got := h.origin.hitCount(name); got != 1 {
			t.Fatalf("origin fetched %s %d times, want 1 (cache + coalescing)", name, got)
		}
	}

	if err := rel.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	gotBytes, gotSegments := h.api.receiptTotals(t)
	if len(gotBytes) != len(served) {
		t.Fatalf("receipts cover %d sessions, served %d", len(gotBytes), len(served))
	}
	for s, want := range served {
		if gotBytes[s] != want || gotSegments[s] != objects[s] {
			t.Fatalf("session %s: receipts %d bytes/%d segments, served %d/%d", s, gotBytes[s], gotSegments[s], want, objects[s])
		}
	}
	h.api.mu.Lock()
	heartbeats := len(h.api.heartbeats)
	h.api.mu.Unlock()
	if heartbeats == 0 {
		t.Fatal("no heartbeats")
	}
	if st := h.health(); st.Status != "draining" {
		t.Fatalf("health after shutdown %+v", st)
	}
	// Nothing left on disk once everything was accepted.
	if left, _ := os.ReadDir(filepath.Join(h.dataDir, "receipts")); len(left) != 0 {
		t.Fatalf("%d receipt files left", len(left))
	}
}

func TestTokenEnforcement(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)
	defer rel.Shutdown(context.Background())

	pl := "/hls/live/alice/index.m3u8?t="
	cases := map[string]struct {
		path string
		want int
	}{
		"no token":     {"/hls/live/alice/index.m3u8", http.StatusUnauthorized},
		"garbage":      {pl + "abc.def", http.StatusUnauthorized},
		"expired":      {pl + h.token(sid(1), func(m map[string]any) { m["exp"] = time.Now().Unix() - 31; m["iat"] = time.Now().Unix() - 200 }), http.StatusUnauthorized},
		"wrong rid":    {pl + h.token(sid(1), func(m map[string]any) { m["rid"] = "01890000-0000-7000-8000-0000000000ab" }), http.StatusForbidden},
		"origin src":   {pl + h.token(sid(1), func(m map[string]any) { m["src"] = "origin"; delete(m, "rid") }), http.StatusForbidden},
		"wrong path":   {"/hls/live/bob/index.m3u8?t=" + h.token(sid(1)), http.StatusForbidden},
		"traversal":    {"/hls/live/alice/../bob/index.m3u8?t=" + h.token(sid(1)), http.StatusForbidden},
		"encoded":      {"/hls/live/alice%2Findex.m3u8?t=" + h.token(sid(1)), http.StatusNotFound},
		"bad blocking": {pl + h.token(sid(1)) + "&_HLS_part=1", http.StatusBadRequest},
		"missing seg":  {"/hls/live/alice/nope.mp4?t=" + h.token(sid(1)), http.StatusNotFound},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			status, body, _ := h.get(t, c.path)
			if status != c.want {
				t.Fatalf("status %d, want %d (%s)", status, c.want, body)
			}
		})
	}
	// Preflight.
	req, _ := http.NewRequest(http.MethodOptions, h.relaySrv.URL+"/hls/live/alice/seg1.mp4", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("preflight %d %v", resp.StatusCode, resp.Header)
	}
}

func TestBlockingParamsPassThroughAndCoalesce(t *testing.T) {
	h := newHarness(t)
	h.origin.mu.Lock()
	h.origin.slow = 100 * time.Millisecond
	h.origin.mu.Unlock()
	rel := h.start(200)
	defer rel.Shutdown(context.Background())

	var wg sync.WaitGroup
	for i := 1; i <= 10; i++ {
		wg.Go(func() {
			status, body, _, err := h.fetch("/hls/live/alice/index.m3u8?_HLS_part=1&_HLS_msn=3&t=" + h.token(sid(i)))
			if err != nil || status != http.StatusOK || !strings.HasPrefix(string(body), "#EXTM3U") {
				t.Errorf("status %d", status)
			}
		})
	}
	wg.Wait()
	// Beyond the live edge (newest msn 3 incl. the in-progress segment, 5 parts
	// per segment): refused without bothering the origin.
	for _, q := range []string{"_HLS_msn=5", "_HLS_msn=3&_HLS_part=6", "_HLS_msn=999999999"} {
		if status, _, _ := h.get(t, "/hls/live/alice/index.m3u8?"+q+"&t="+h.token(sid(1))); status != http.StatusBadRequest {
			t.Fatalf("%s: status %d, want 400", q, status)
		}
	}
	if status, _, _ := h.get(t, "/hls/live/alice/index.m3u8?_HLS_msn=4&_HLS_part=0&t="+h.token(sid(1))); status != http.StatusOK {
		t.Fatalf("next segment's first part refused: %d", status)
	}
	h.origin.mu.Lock()
	defer h.origin.mu.Unlock()
	var blocking []string
	plain := 0
	for _, q := range h.origin.queries {
		if q == "" {
			plain++ // bounds check; refreshed when its short TTL lapses
		} else {
			blocking = append(blocking, q)
		}
	}
	want := []string{"_HLS_msn=3&_HLS_part=1", "_HLS_msn=4&_HLS_part=0"}
	if plain == 0 || fmt.Sprint(blocking) != fmt.Sprint(want) {
		t.Fatalf("origin playlist queries %q, want plain bounds checks plus exactly %q", h.origin.queries, want)
	}
}

func TestSuspendedReturns410AndKeepsHeartbeating(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)
	defer rel.Shutdown(context.Background())
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+h.token(sid(1))); status != http.StatusOK {
		t.Fatalf("active relay status %d", status)
	}
	h.api.set(func(a *fakeAPI) { a.status = "suspended" })
	h.eventually("suspension", func() bool {
		status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+h.token(sid(1)))
		return status == http.StatusGone
	})
	if st := h.health(); st.Status != "suspended" {
		t.Fatalf("health %+v", st)
	}
	h.api.mu.Lock()
	before := len(h.api.heartbeats)
	h.api.mu.Unlock()
	h.eventually("heartbeats while suspended", func() bool {
		h.api.mu.Lock()
		defer h.api.mu.Unlock()
		return len(h.api.heartbeats) >= before+2
	})
	h.api.set(func(a *fakeAPI) { a.status = "active" })
	h.eventually("reinstatement", func() bool {
		status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+h.token(sid(1)))
		return status == http.StatusOK
	})
}

func TestReregistersWhenUnknown(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)
	defer rel.Shutdown(context.Background())
	h.api.set(func(a *fakeAPI) { a.unknownOnce = true })
	h.eventually("re-registration", func() bool {
		h.api.mu.Lock()
		defer h.api.mu.Unlock()
		return h.api.registrations >= 2
	})
}

func TestCapacityLimit(t *testing.T) {
	h := newHarness(t)
	rel := h.start(5) // 5 Mbps / 5 Mbps per viewer = 1 viewer
	defer rel.Shutdown(context.Background())
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+h.token(sid(1))); status != http.StatusOK {
		t.Fatalf("first viewer %d", status)
	}
	status, _, hdr := h.get(t, "/hls/live/alice/seg1.mp4?t="+h.token(sid(2)))
	if status != http.StatusServiceUnavailable || hdr.Get("Retry-After") == "" {
		t.Fatalf("second viewer %d", status)
	}
	if status, _, _ := h.get(t, "/hls/live/alice/seg2.mp4?t="+h.token(sid(1))); status != http.StatusOK {
		t.Fatalf("admitted viewer refused: %d", status)
	}
}

func TestUnsentReceiptsSurviveRestart(t *testing.T) {
	h := newHarness(t)
	h.api.set(func(a *fakeAPI) { a.receiptStatus = http.StatusServiceUnavailable })
	rel := h.start(200)
	served, objects := h.mustWatch(t, sid(7))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	if err := rel.Shutdown(ctx); err == nil {
		t.Fatal("shutdown reported delivery while the API refused receipts")
	}
	cancel()
	files, _ := os.ReadDir(filepath.Join(h.dataDir, "receipts"))
	if len(files) == 0 {
		t.Fatal("no receipts persisted")
	}
	h.api.mu.Lock()
	firstKey := h.api.relayPub
	if len(h.api.receipts) != 0 {
		t.Fatal("receipts accepted while failing")
	}
	h.api.receiptStatus = 0
	h.api.mu.Unlock()

	rel2 := h.start(200)
	h.eventually("backlog delivery", func() bool {
		h.api.mu.Lock()
		defer h.api.mu.Unlock()
		return len(h.api.receipts) >= len(files)
	})
	if err := rel2.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.api.relayPub != firstKey {
		t.Fatal("identity changed across restart")
	}
	gotBytes, gotSegments := h.api.receiptTotals(t)
	if gotBytes[sid(7)] != served || gotSegments[sid(7)] != objects {
		t.Fatalf("after restart receipts sum %d bytes/%d segments, served %d/%d", gotBytes[sid(7)], gotSegments[sid(7)], served, objects)
	}
}
