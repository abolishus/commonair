// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"net/http"
	"strings"
	"testing"
)

func mediaOrigin(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, ".m3u8") {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,\nseg1.mp4\n"))
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	_, _ = w.Write(make([]byte, 1000))
}

func TestDrainKeepsCurrentViewersAndRefusesNewOnes(t *testing.T) {
	f := newFixture(t, mediaOrigin)
	const sid2 = "01890000-0000-7000-8000-000000000002"
	if resp := f.do(t, http.MethodGet, "/hls/live/alice/seg1.mp4?t="+f.token(sid1), nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("before drain: %d", resp.StatusCode)
	}
	f.srv.Drain()
	for _, p := range []string{"/hls/live/alice/seg2.mp4", "/hls/live/alice/index.m3u8"} {
		if resp := f.do(t, http.MethodGet, p+"?t="+f.token(sid1), nil); resp.StatusCode != http.StatusOK {
			t.Fatalf("current viewer refused while draining (%s): %d", p, resp.StatusCode)
		}
	}
	resp := f.do(t, http.MethodGet, "/hls/live/alice/seg1.mp4?t="+f.token(sid2), nil)
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("new viewer while draining: %d", resp.StatusCode)
	}
	// A bad token is still a bad token, draining or not.
	if resp := f.do(t, http.MethodGet, "/hls/live/alice/seg1.mp4?t=nope", nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad token while draining: %d", resp.StatusCode)
	}
}

// hls.js fetches with CORS from the web origin, sends Range for byte-range
// parts and may preflight; every answer must carry the CORS headers.
func TestCORSCoversHLSJS(t *testing.T) {
	f := newFixture(t, mediaOrigin)
	check := func(what string, resp *http.Response) {
		t.Helper()
		h := resp.Header
		if h.Get("Access-Control-Allow-Origin") != "*" ||
			!strings.Contains(h.Get("Access-Control-Expose-Headers"), "Content-Range") ||
			!strings.Contains(h.Get("Access-Control-Expose-Headers"), "Content-Length") {
			t.Fatalf("%s: CORS headers missing: %v", what, h)
		}
	}
	pre := f.do(t, http.MethodOptions, "/hls/live/alice/seg1.mp4", map[string]string{
		"Origin": "https://commonair.test", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range",
	})
	if pre.StatusCode != http.StatusNoContent || !strings.Contains(pre.Header.Get("Access-Control-Allow-Headers"), "Range") ||
		!strings.Contains(pre.Header.Get("Access-Control-Allow-Methods"), "GET") {
		t.Fatalf("preflight %d %v", pre.StatusCode, pre.Header)
	}
	check("preflight", pre)
	tok := f.token(sid1)
	ranged := f.do(t, http.MethodGet, "/hls/live/alice/seg1.mp4?t="+tok, map[string]string{"Origin": "https://commonair.test", "Range": "bytes=10-19"})
	if ranged.StatusCode != http.StatusPartialContent || ranged.Header.Get("Content-Range") != "bytes 10-19/1000" {
		t.Fatalf("range %d %v", ranged.StatusCode, ranged.Header)
	}
	check("range", ranged)
	check("playlist", f.do(t, http.MethodGet, "/hls/live/alice/index.m3u8?t="+tok, map[string]string{"Origin": "https://commonair.test"}))
	// Errors too, or the player cannot read the status and retry sensibly.
	check("unauthorized", f.do(t, http.MethodGet, "/hls/live/alice/seg1.mp4", map[string]string{"Origin": "https://commonair.test"}))
}
