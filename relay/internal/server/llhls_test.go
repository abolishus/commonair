// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// llPlaylist is a MediaMTX-shaped LL-HLS media playlist (1 s segments,
// 0.2 s parts) whose newest complete segment is last.
func llPlaylist(last int) string {
	return fmt.Sprintf("#EXTM3U\n#EXT-X-VERSION:10\n#EXT-X-TARGETDURATION:1\n"+
		"#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.50000,CAN-SKIP-UNTIL=6.00000\n"+
		"#EXT-X-PART-INF:PART-TARGET=0.20000\n#EXT-X-MEDIA-SEQUENCE:%d\n#EXT-X-MAP:URI=\"v_init.mp4\"\n"+
		"#EXTINF:1.00000,\nv_seg%d.mp4\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"v_part0.mp4\"\n", last, last)
}

// A player asks for the part after the blocking response it just received;
// the relay's cached plain playlist may predate that response. The bounds
// check must not answer 400 for a part the origin already announced.
func TestBlockingBoundsRecheckAgainstFreshPlaylist(t *testing.T) {
	var last atomic.Int64
	last.Store(10)
	var mu sync.Mutex
	var queries []string
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		queries = append(queries, r.URL.RawQuery)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = w.Write([]byte(llPlaylist(int(last.Load()))))
	}, func(c *Config) { c.PlaylistTTL = time.Minute })
	tok := f.token(sid1)
	get := func(q string) int {
		return f.do(t, http.MethodGet, "/hls/live/alice/index.m3u8?"+q+"&t="+tok, nil).StatusCode
	}
	if s := get("_HLS_msn=11&_HLS_part=0"); s != http.StatusOK {
		t.Fatalf("next part: %d", s)
	}
	last.Store(12) // the stream moved on; the cached plain copy says 10
	if s := get("_HLS_msn=13&_HLS_part=0"); s != http.StatusOK {
		t.Fatalf("part announced by the origin refused against a stale cache: %d", s)
	}
	if s := get("_HLS_msn=15&_HLS_part=0"); s != http.StatusBadRequest {
		t.Fatalf("beyond the fresh edge: %d", s)
	}
	if s := get("_HLS_msn=12&_HLS_part=9"); s != http.StatusBadRequest {
		t.Fatalf("part beyond a segment's capacity: %d", s)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, q := range queries {
		if q == "_HLS_msn=15&_HLS_part=0" || q == "_HLS_msn=12&_HLS_part=9" {
			t.Fatalf("refused request reached the origin: %q", queries)
		}
	}
}
