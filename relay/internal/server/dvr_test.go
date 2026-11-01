// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/abolishus/commonair/relay/internal/tokens"
)

const (
	vodA = "01890000-0000-7000-8000-000000000009"
	vodB = "01890000-0000-7000-8000-00000000000b"
)

// clock is a settable time source shared by the server and its cache.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// dvrOrigin fakes /relay-pull/dvr/<vodA>/…: a playlist listing init.mp4 and
// seg1.mp4 (8 s of media), the segments, and switches for failure modes.
type dvrOrigin struct {
	playlistStatus atomic.Int32 // 0 = 200
	playlists      atomic.Int32
	segments       atomic.Int32
	captions       atomic.Int32
	auth           atomic.Value
	paths          sync.Map
}

func (o *dvrOrigin) handle(w http.ResponseWriter, r *http.Request) {
	o.auth.Store(r.Header.Get("Authorization"))
	o.paths.Store(r.URL.Path, true)
	switch {
	case strings.HasSuffix(r.URL.Path, ".vtt"):
		o.captions.Add(1)
		w.Header().Set("Content-Type", "text/vtt")
		_, _ = io.WriteString(w, "WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n")
	case strings.HasPrefix(r.URL.Path, "/relay-pull/dvr/"+vodA+"/index.m3u8"):
		o.playlists.Add(1)
		if st := o.playlistStatus.Load(); st != 0 {
			w.WriteHeader(int(st))
			return
		}
		_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n"+
			"#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.000000,\nseg1.mp4\n#EXTINF:4.000000,\nseg2.mp4\n")
	case strings.HasPrefix(r.URL.Path, "/relay-pull/dvr/"+vodA+"/"), strings.HasPrefix(r.URL.Path, "/relay-pull/live/"):
		o.segments.Add(1)
		_, _ = io.WriteString(w, strings.Repeat("d", 4000))
	default:
		http.NotFound(w, r)
	}
}

func newDvrFixture(t *testing.T) (*fixture, *dvrOrigin, *clock) {
	t.Helper()
	o := &dvrOrigin{}
	clk := &clock{t: time.Now()}
	f := newFixture(t, o.handle, func(c *Config) {
		c.Now = clk.now
		c.Store.SetClock(clk.now)
	})
	return f, o, clk
}

// tokenFor signs claims over the fixture's origin key (valid for 120 s from now).
func (f *fixture) tokenFor(claims map[string]any) string {
	now := time.Now().Unix()
	c := map[string]any{"v": 1, "sid": sid1, "cid": rid, "src": "relay", "rid": rid, "iat": now, "exp": now + 120}
	for k, v := range claims {
		if v == nil {
			delete(c, k)
		} else {
			c[k] = v
		}
	}
	b, _ := json.Marshal(c)
	return tokens.EncodeB64URL(b) + "." + tokens.EncodeB64URL(ed25519.Sign(f.key, b))
}

func (f *fixture) dvrToken() string { return f.tokenFor(map[string]any{"path": "dvr/" + vodA}) }

func (f *fixture) get(t *testing.T, path string) (*http.Response, string) {
	t.Helper()
	resp, err := http.Get(f.ts.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func (f *fixture) cut(t *testing.T, wantSegments int64) (bytes, segments int64) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		for _, e := range f.ledger.Cut(time.Now()).Entries {
			bytes += e.Bytes
			segments += e.Segments
		}
		if segments >= wantSegments || time.Now().After(deadline) {
			return bytes, segments
		}
	}
}

func TestDvrTokenChecks(t *testing.T) {
	f, o, _ := newDvrFixture(t)
	seg := "/dvr/" + vodA + "/seg1.mp4?t="
	cases := map[string]struct {
		path string
		want int
	}{
		"origin token":     {seg + f.tokenFor(map[string]any{"path": "dvr/" + vodA, "src": "origin", "rid": nil}), http.StatusForbidden},
		"cdn token":        {seg + f.tokenFor(map[string]any{"path": "dvr/" + vodA, "src": "cdn", "rid": nil}), http.StatusForbidden},
		"another relay":    {seg + f.tokenFor(map[string]any{"path": "dvr/" + vodA, "rid": "01890000-0000-7000-8000-0000000000bb"}), http.StatusForbidden},
		"another VOD":      {seg + f.tokenFor(map[string]any{"path": "dvr/" + vodB}), http.StatusForbidden},
		"live token":       {seg + f.tokenFor(map[string]any{"path": "live/alice"}), http.StatusForbidden},
		"data mode":        {seg + f.tokenFor(map[string]any{"path": "dvr/" + vodA, "dm": 500000}), http.StatusUnauthorized},
		"no token":         {"/dvr/" + vodA + "/seg1.mp4", http.StatusUnauthorized},
		"uppercase vod":    {"/dvr/" + strings.ToUpper(vodB) + "/seg1.mp4?t=" + f.tokenFor(map[string]any{"path": "dvr/" + vodB}), http.StatusNotFound},
		"not a uuid":       {"/dvr/alice/seg1.mp4?t=" + f.dvrToken(), http.StatusNotFound},
		"nested":           {"/dvr/" + vodA + "/x/seg1.mp4?t=" + f.dvrToken(), http.StatusNotFound},
		"other extension":  {"/dvr/" + vodA + "/seg1.ts?t=" + f.dvrToken(), http.StatusNotFound},
		"another playlist": {"/dvr/" + vodA + "/other.m3u8?t=" + f.dvrToken(), http.StatusNotFound},
	}
	for name, c := range cases {
		if resp, _ := f.get(t, c.path); resp.StatusCode != c.want {
			t.Errorf("%s: %d, want %d", name, resp.StatusCode, c.want)
		}
	}
	if o.playlists.Load() != 0 || o.segments.Load() != 0 {
		t.Fatal("a refused request reached the origin")
	}
}

func TestDvrServesListedSegmentsAndCountsThem(t *testing.T) {
	f, o, _ := newDvrFixture(t)
	tok := f.dvrToken()
	resp, body := f.get(t, "/dvr/"+vodA+"/index.m3u8?t="+tok)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") != "private, no-store" ||
		resp.Header.Get("Content-Type") != "application/vnd.apple.mpegurl" {
		t.Fatalf("playlist %d %v", resp.StatusCode, resp.Header)
	}
	if !strings.Contains(body, "seg1.mp4?t="+tok) || !strings.Contains(body, `URI="init.mp4?t=`+tok) {
		t.Fatalf("playlist not rewritten with the token:\n%s", body)
	}
	if a, _ := o.auth.Load().(string); a != "Bearer relay_x" {
		t.Fatalf("origin auth %q", a)
	}
	if _, ok := o.paths.Load("/relay-pull/dvr/" + vodA + "/index.m3u8"); !ok {
		t.Fatal("the playlist was not pulled from /relay-pull/dvr/")
	}
	resp, body = f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok)
	if resp.StatusCode != http.StatusOK || len(body) != 4000 || resp.Header.Get("Cache-Control") != "private, no-store" ||
		resp.Header.Get("Content-Type") != "video/mp4" || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("segment %d %v", resp.StatusCode, resp.Header)
	}
	// Served again from the cache: one origin fetch, two counted segments.
	if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusOK {
		t.Fatal(resp.StatusCode)
	}
	if o.segments.Load() != 1 {
		t.Fatalf("origin segment fetches %d", o.segments.Load())
	}
	bytes, segments := f.cut(t, 2)
	if bytes != 8000 || segments != 2 {
		t.Fatalf("ledger bytes %d segments %d (playlists are never counted)", bytes, segments)
	}
	// HEAD bills nothing.
	if resp := f.do(t, http.MethodHead, "/dvr/"+vodA+"/seg2.mp4?t="+tok, nil); resp.StatusCode != http.StatusOK {
		t.Fatal(resp.StatusCode)
	}
	if b, s := f.cut(t, 0); b != 0 || s != 0 {
		t.Fatalf("HEAD billed %d/%d", b, s)
	}
}

// A DVR token on the live /hls/ route would skip the listing, freshness and
// tombstone rules and cache DVR media as immutable: the live route takes live/ only.
func TestHlsRouteRefusesDvrPaths(t *testing.T) {
	f, o, _ := newDvrFixture(t)
	tok := f.dvrToken()
	for _, p := range []string{"/hls/dvr/" + vodA + "/seg1.mp4?t=" + tok, "/hls/dvr/" + vodA + "/index.m3u8?t=" + tok} {
		if resp, _ := f.get(t, p); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: %d", p, resp.StatusCode)
		}
	}
	if o.segments.Load() != 0 || o.playlists.Load() != 0 {
		t.Fatalf("the origin was asked: %d segments, %d playlists", o.segments.Load(), o.playlists.Load())
	}
}

func TestDvrRefusesUnlistedSegments(t *testing.T) {
	f, o, _ := newDvrFixture(t)
	if resp, _ := f.get(t, "/dvr/"+vodA+"/seg9.mp4?t="+f.dvrToken()); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unlisted segment: %d", resp.StatusCode)
	}
	if o.playlists.Load() != 1 || o.segments.Load() != 0 {
		t.Fatalf("playlists %d segments %d: an unlisted segment is never pulled", o.playlists.Load(), o.segments.Load())
	}
	if _, s := f.cut(t, 0); s != 0 {
		t.Fatal("a 404 was counted")
	}
}

// With the origin unreachable the relay keeps serving its last good playlist
// for under 5 s, then answers 404 even for a cached segment.
func TestDvrStalePlaylistStopsServing(t *testing.T) {
	f, o, clk := newDvrFixture(t)
	tok := f.dvrToken()
	if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusOK {
		t.Fatal(resp.StatusCode)
	}
	o.playlistStatus.Store(http.StatusInternalServerError)
	clk.add(4900 * time.Millisecond)
	if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusOK {
		t.Fatalf("under 5 s: %d", resp.StatusCode)
	}
	if o.playlists.Load() != 2 {
		t.Fatalf("the playlist was not re-read after 1 s: %d fetches", o.playlists.Load())
	}
	clk.add(200 * time.Millisecond)
	if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("over 5 s: %d", resp.StatusCode)
	}
	// It recovers once the origin answers again.
	o.playlistStatus.Store(0)
	clk.add(DvrPlaylistTTL)
	if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusOK {
		t.Fatalf("after recovery: %d", resp.StatusCode)
	}
	if o.segments.Load() != 1 {
		t.Fatalf("segment re-pulled: %d", o.segments.Load())
	}
}

// A 404 or 403 from the origin evicts the VOD's prefix at once.
func TestDvrOriginRefusalEvicts(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusForbidden} {
		f, o, clk := newDvrFixture(t)
		tok := f.dvrToken()
		if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusOK {
			t.Fatal(resp.StatusCode)
		}
		o.playlistStatus.Store(int32(status))
		clk.add(DvrPlaylistTTL)
		if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("origin %d: %d", status, resp.StatusCode)
		}
		if n := f.srv.cfg.Store.LRU.Len(); n != 0 {
			t.Fatalf("origin %d: %d entries left for the VOD", status, n)
		}
		// No tombstone: once the origin serves the DVR again, so does the relay.
		o.playlistStatus.Store(0)
		clk.add(DvrPlaylistTTL)
		if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusOK {
			t.Fatalf("origin %d, after: %d", status, resp.StatusCode)
		}
	}
}

func TestDvrPurgeEvictsAndHoldsOff(t *testing.T) {
	f, o, clk := newDvrFixture(t)
	tok := f.dvrToken()
	if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusOK {
		t.Fatal(resp.StatusCode)
	}
	f.srv.PurgePrefix("dvr/" + vodA + "/")
	if f.srv.cfg.Store.LRU.Len() != 0 {
		t.Fatal("purge left entries")
	}
	before := o.playlists.Load() + o.segments.Load()
	for _, p := range []string{"seg1.mp4", "index.m3u8"} {
		if resp, _ := f.get(t, "/dvr/"+vodA+"/"+p+"?t="+tok); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s after purge: %d", p, resp.StatusCode)
		}
	}
	if o.playlists.Load()+o.segments.Load() != before {
		t.Fatal("the relay asked the origin within the tombstone")
	}
	clk.add(61 * time.Second)
	if resp, _ := f.get(t, "/dvr/"+vodA+"/seg1.mp4?t="+tok); resp.StatusCode != http.StatusOK {
		t.Fatalf("after the tombstone: %d", resp.StatusCode)
	}
	// A reset evicts live and DVR objects alike.
	f.get(t, "/hls/live/alice/x.vtt?t="+f.token(sid1))
	f.srv.PurgeAll()
	if f.srv.cfg.Store.LRU.Len() != 0 {
		t.Fatal("reset left entries")
	}
}

func TestHealthReportsPurgeSeq(t *testing.T) {
	f := newFixture(t, func(http.ResponseWriter, *http.Request) {}, func(c *Config) { c.PurgeSeq = func() int64 { return 42 } })
	_, body := f.get(t, "/healthz")
	var h Health
	if err := json.Unmarshal([]byte(body), &h); err != nil || h.PurgeSeq == nil || *h.PurgeSeq != 42 {
		t.Fatalf("%s", body)
	}
	g := newFixture(t, func(http.ResponseWriter, *http.Request) {})
	if _, body := g.get(t, "/healthz"); strings.Contains(body, "purgeSeq") {
		t.Fatalf("%s", body)
	}
}

// Decision (y): caption files are neither counted nor pinned.
func TestCaptionVttIsNotCountedNorPinned(t *testing.T) {
	f, o, clk := newDvrFixture(t)
	tok := f.token(sid1)
	path := "/hls/live/alice/captions/en/c42.vtt?t=" + tok
	resp, body := f.get(t, path)
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(body, "WEBVTT") {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "private, max-age=30" || strings.Contains(cc, "immutable") {
		t.Fatalf("cache-control %q", cc)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/vtt" {
		t.Fatalf("content-type %q", ct)
	}
	clk.add(CaptionTTL - time.Second)
	f.get(t, path)
	if o.captions.Load() != 1 {
		t.Fatalf("re-pulled within 30 s: %d", o.captions.Load())
	}
	clk.add(time.Second)
	f.get(t, path)
	if o.captions.Load() != 2 {
		t.Fatalf("still cached after 30 s: %d", o.captions.Load())
	}
	if b, s := f.cut(t, 0); b != 0 || s != 0 {
		t.Fatalf("captions counted: %d bytes, %d segments", b, s)
	}
	// A media segment on the same route still counts, and stays pinned.
	resp, _ = f.get(t, "/hls/live/alice/seg1.mp4?t="+tok)
	if resp.Header.Get("Cache-Control") != "private, max-age=86400, immutable" {
		t.Fatalf("segment cache-control %q", resp.Header.Get("Cache-Control"))
	}
	if _, s := f.cut(t, 1); s != 1 {
		t.Fatal("segment not counted")
	}
}
