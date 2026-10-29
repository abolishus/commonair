// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package hls

import (
	"net/url"
	"path"
	"strings"
	"testing"
)

// Request paths come straight from viewers; a valid one must already be clean and relative.
func FuzzValidPath(f *testing.F) {
	for _, s := range []string{"live/alice/index.m3u8", "live/../etc/passwd", "/abs", "a//b", "a/./b", ".hidden", "a%2e%2e/b"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, p string) {
		if !ValidPath(p) {
			return
		}
		if path.Clean(p) != p || strings.HasPrefix(p, "/") || strings.Contains(p, "..") {
			t.Fatalf("ValidPath accepted unclean path %q", p)
		}
	})
}

// Playlists come from the origin. Whatever it sends, every media line the relay serves must
// point inside the token's scope and carry the token exactly once.
func FuzzRewrite(f *testing.F) {
	f.Add([]byte(llMedia))
	f.Add([]byte("#EXTM3U\n#EXTINF:2,\n../../bob/seg.mp4\n"))
	f.Add([]byte("#EXTM3U\n#EXTINF:2,\nhttps://evil.test/relay-pull/live/alice/seg.mp4\n"))
	f.Add([]byte("#EXTM3U\n#EXTINF:2,\nseg.mp4?t=a&t=b\n"))
	f.Add([]byte("\xef\xbb\xbf#EXTM3U\r\n#EXT-X-MAP:URI=\"init.mp4\"\r\n"))
	base, err := url.Parse("https://origin.test/relay-pull/")
	if err != nil {
		f.Fatal(err)
	}
	rw := Rewriter{PullBase: base}
	const scope = "live/alice"
	f.Fuzz(func(t *testing.T, body []byte) {
		out, err := rw.Rewrite(body, scope+"/index.m3u8", scope, tok)
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			ref, err := url.Parse(line)
			if err != nil {
				t.Fatalf("rewritten line %q does not parse: %v", line, err)
			}
			if ref.Scheme != "" {
				continue // data:, skd: and the like pass through untouched
			}
			target := path.Join(scope, ref.Path)
			if ref.Host != "" || !ValidPath(target) || !strings.HasPrefix(target, scope+"/") {
				t.Fatalf("rewritten line %q escapes %s", line, scope)
			}
			if got := ref.Query()["t"]; len(got) != 1 || got[0] != tok {
				t.Fatalf("rewritten line %q carries t=%v, want the token once", line, got)
			}
		}
	})
}

func FuzzParseLimits(f *testing.F) {
	f.Add([]byte(llMedia))
	f.Add([]byte("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9223372036854775807\n#EXTINF:2,\na.mp4\n"))
	f.Add([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:1e308\n#EXT-X-PART-INF:PART-TARGET=1e-300\n#EXT-X-MEDIA-SEQUENCE:1\n"))
	f.Add([]byte("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-SKIP:SKIPPED-SEGMENTS=-50\n"))
	f.Fuzz(func(t *testing.T, body []byte) {
		l, ok := ParseLimits(body)
		// LastMSN is -1 for a playlist with a sequence but no segments yet.
		if ok && (l.LastMSN < -1 || l.PartsPerSegment < 0) {
			t.Fatalf("negative limits %+v", l)
		}
	})
}

func FuzzParseDirectives(f *testing.F) {
	f.Add("_HLS_msn=12&_HLS_part=3&_HLS_skip=YES")
	f.Add("_HLS_part=1")
	f.Add("_HLS_msn=-1")
	f.Fuzz(func(t *testing.T, raw string) {
		q, err := url.ParseQuery(raw)
		if err != nil {
			return
		}
		d, err := ParseDirectives(q)
		if err != nil {
			return
		}
		if d.MSN < -1 || d.Part < -1 || (d.Part >= 0 && d.MSN < 0) {
			t.Fatalf("directives %+v from %q", d, raw)
		}
		again, err := BlockingQuery(mustQuery(t, d.Query))
		if err != nil || again != d.Query {
			t.Fatalf("canonical query %q is not stable (%q, %v)", d.Query, again, err)
		}
	})
}

func mustQuery(t *testing.T, s string) url.Values {
	t.Helper()
	q, err := url.ParseQuery(s)
	if err != nil {
		t.Fatalf("canonical query %q does not parse: %v", s, err)
	}
	return q
}
