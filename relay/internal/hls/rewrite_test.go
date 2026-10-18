// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package hls

import (
	"errors"
	"net/url"
	"strings"
	"testing"
)

const tok = "eyJ2IjoxfQ.c2ln"

func rewriter(t *testing.T, base string) Rewriter {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	return Rewriter{PullBase: u}
}

const llMedia = "#EXTM3U\r\n" +
	"#EXT-X-VERSION:9\r\n" +
	"#EXT-X-TARGETDURATION:2\r\n" +
	"#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.60000,CAN-SKIP-UNTIL=12\r\n" +
	"#EXT-X-PART-INF:PART-TARGET=0.20000\r\n" +
	"#EXT-X-MEDIA-SEQUENCE:10\r\n" +
	"#EXT-X-MAP:URI=\"a1_init.mp4\"\r\n" +
	"#EXT-X-PROGRAM-DATE-TIME:2026-10-18T10:00:00.000Z\r\n" +
	"#EXTINF:2.00000,\r\n" +
	"a1_seg10.mp4\r\n" +
	"#EXT-X-PART:DURATION=0.20000,URI=\"a1_part50.mp4\",INDEPENDENT=YES\r\n" +
	"#EXT-X-PART:DURATION=0.20000,URI=\"a1_part51.mp4?x=1&t=old\"\r\n" +
	"#EXTINF:2.00000,\r\n" +
	"/relay-pull/live/alice/a1_seg11.mp4\r\n" +
	"# a plain comment\r\n" +
	"#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"a1_part56.mp4\"\r\n" +
	"#EXT-X-RENDITION-REPORT:URI=\"720p/index.m3u8\",LAST-MSN=12,LAST-PART=3\r\n"

func TestRewriteLLHLSMediaPlaylist(t *testing.T) {
	rw := rewriter(t, "https://origin.test/relay-pull/")
	out, err := rw.Rewrite([]byte(llMedia), "live/alice/index.m3u8", "live/alice", tok)
	if err != nil {
		t.Fatal(err)
	}
	want := "#EXTM3U\n" +
		"#EXT-X-VERSION:9\n" +
		"#EXT-X-TARGETDURATION:2\n" +
		"#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.60000,CAN-SKIP-UNTIL=12\n" +
		"#EXT-X-PART-INF:PART-TARGET=0.20000\n" +
		"#EXT-X-MEDIA-SEQUENCE:10\n" +
		"#EXT-X-MAP:URI=\"a1_init.mp4?t=" + tok + "\"\n" +
		"#EXT-X-PROGRAM-DATE-TIME:2026-10-18T10:00:00.000Z\n" +
		"#EXTINF:2.00000,\n" +
		"a1_seg10.mp4?t=" + tok + "\n" +
		"#EXT-X-PART:DURATION=0.20000,URI=\"a1_part50.mp4?t=" + tok + "\",INDEPENDENT=YES\n" +
		"#EXT-X-PART:DURATION=0.20000,URI=\"a1_part51.mp4?x=1&t=" + tok + "\"\n" +
		"#EXTINF:2.00000,\n" +
		"a1_seg11.mp4?t=" + tok + "\n" +
		"# a plain comment\n" +
		"#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"a1_part56.mp4?t=" + tok + "\"\n" +
		"#EXT-X-RENDITION-REPORT:URI=\"720p/index.m3u8?t=" + tok + "\",LAST-MSN=12,LAST-PART=3\n"
	if string(out) != want {
		t.Fatalf("rewrite mismatch:\n--- got\n%s\n--- want\n%s", out, want)
	}
	if n := strings.Count(string(out), "t="); n != 7 {
		t.Fatalf("token appears %d times, want once per URI (7)", n)
	}
}

func TestRewriteRenditionRelativePaths(t *testing.T) {
	rw := rewriter(t, "https://origin.test/prefix/relay-pull/")
	in := "#EXTM3U\n" +
		"#EXT-X-MAP:URI=\"init.mp4\"\n" +
		"#EXTINF:2,\nseg1.mp4\n" +
		"#EXT-X-RENDITION-REPORT:URI=\"../480p/index.m3u8\",LAST-MSN=3\n" +
		"#EXT-X-RENDITION-REPORT:URI=\"../index.m3u8\",LAST-MSN=3\n" +
		"#EXTINF:2,\nhttps://origin.test/prefix/relay-pull/live/alice/720p/seg2.mp4\n"
	out, err := rw.Rewrite([]byte(in), "live/alice/720p/index.m3u8", "live/alice", tok)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`URI="init.mp4?t=` + tok + `"`,
		"\nseg1.mp4?t=" + tok + "\n",
		`URI="../480p/index.m3u8?t=` + tok + `"`,
		`URI="../index.m3u8?t=` + tok + `"`,
		"\nseg2.mp4?t=" + tok + "\n",
	} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("missing %q in\n%s", want, out)
		}
	}
}

func TestRewriteMultivariant(t *testing.T) {
	rw := rewriter(t, "https://origin.test/relay-pull/")
	in := "#EXTM3U\n" +
		"#EXT-X-INDEPENDENT-SEGMENTS\n" +
		"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"a,b\",DEFAULT=YES,URI=\"audio/index.m3u8\"\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS=\"avc1.64001f,mp4a.40.2\",RESOLUTION=1280x720,AUDIO=\"aud\"\n" +
		"720p/index.m3u8\n" +
		"#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI=\"720p/iframes.m3u8\"\n" +
		"#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://steer.invalid/x\"\n"
	out, err := rw.Rewrite([]byte(in), "live/alice/index.m3u8", "live/alice", tok)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`NAME="a,b",DEFAULT=YES,URI="audio/index.m3u8?t=` + tok + `"`,
		`CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aud"` + "\n720p/index.m3u8?t=" + tok,
		`URI="720p/iframes.m3u8?t=` + tok + `"`,
		// SERVER-URI is not a media URI and must not be touched.
		`SERVER-URI="https://steer.invalid/x"`,
	} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("missing %q in\n%s", want, out)
		}
	}
}

func TestRewriteRejectsEscapes(t *testing.T) {
	rw := rewriter(t, "https://origin.test/relay-pull/")
	cases := map[string]string{
		"other stream":  "#EXTM3U\n#EXTINF:2,\n../bob/seg.mp4\n",
		"other host":    "#EXTM3U\n#EXTINF:2,\nhttps://evil.test/relay-pull/live/alice/seg.mp4\n",
		"outside pull":  "#EXTM3U\n#EXTINF:2,\n/admin/live/alice/seg.mp4\n",
		"map escape":    "#EXTM3U\n#EXT-X-MAP:URI=\"../../x.mp4\"\n",
		"no header":     "#EXTINF:2,\nseg.mp4\n",
		"empty":         "",
		"unterminated":  "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\n",
		"bad character": "#EXTM3U\n#EXTINF:2,\nseg%20one.mp4\n",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := rw.Rewrite([]byte(in), "live/alice/index.m3u8", "live/alice", tok); !errors.Is(err, ErrBadPlaylist) {
				t.Fatalf("got %v, want ErrBadPlaylist", err)
			}
		})
	}
}

func TestRewriteLeavesNonHTTPSchemes(t *testing.T) {
	rw := rewriter(t, "https://origin.test/relay-pull/")
	in := "#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI=\"skd://key\"\n"
	out, err := rw.Rewrite([]byte(in), "live/alice/index.m3u8", "live/alice", tok)
	if err != nil || !strings.Contains(string(out), `URI="skd://key"`) {
		t.Fatalf("%v\n%s", err, out)
	}
}

func TestValidPath(t *testing.T) {
	for _, p := range []string{"live/alice/index.m3u8", "live/a-b_c/720p/x_seg1.mp4"} {
		if !ValidPath(p) {
			t.Fatalf("%q rejected", p)
		}
	}
	for _, p := range []string{"", "/live/a", "live//a", "live/../a", "live/a/", "live/.hidden", "live/a b", "live/a%2F", "live/a\\b", strings.Repeat("a/", 9) + "x"} {
		if ValidPath(p) {
			t.Fatalf("%q accepted", p)
		}
	}
}

func TestBlockingQuery(t *testing.T) {
	q := func(s string) url.Values { v, _ := url.ParseQuery(s); return v }
	ok := map[string]string{
		"":                                      "",
		"t=abc":                                 "",
		"_HLS_part=2&_HLS_msn=10&t=x":           "_HLS_msn=10&_HLS_part=2",
		"_HLS_skip=YES&_HLS_msn=3":              "_HLS_msn=3&_HLS_skip=YES",
		"_HLS_skip=v2":                          "_HLS_skip=v2",
		"_HLS_msn=10&_HLS_part=0&other=ignored": "_HLS_msn=10&_HLS_part=0",
	}
	for in, want := range ok {
		got, err := BlockingQuery(q(in))
		if err != nil || got != want {
			t.Fatalf("%q: got %q %v, want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"_HLS_msn=-1", "_HLS_msn=abc", "_HLS_part=1", "_HLS_msn=1&_HLS_part=x", "_HLS_skip=no"} {
		if _, err := BlockingQuery(q(in)); err == nil {
			t.Fatalf("%q accepted", in)
		}
	}
}
