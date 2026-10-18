// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package hls

import (
	"errors"
	"net/url"
	"testing"
)

func TestParseLimitsLLHLS(t *testing.T) {
	// llMedia: sequence 10, two complete segments (10, 11) and no parts after
	// the last EXTINF; 2 s target / 0.2 s parts = 10 parts per segment.
	l, ok := ParseLimits([]byte(llMedia))
	if !ok || l.LastMSN != 11 || l.PartsPerSegment != 10 {
		t.Fatalf("limits %+v ok=%v", l, ok)
	}
	inProgress := "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART-INF:PART-TARGET=0.5\n#EXT-X-MEDIA-SEQUENCE:100\n" +
		"#EXTINF:2,\ns100.mp4\n" +
		"#EXT-X-PART:DURATION=0.5,URI=\"p0.mp4\"\n#EXT-X-PART:DURATION=0.5,URI=\"p1.mp4\"\n" +
		"#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"p2.mp4\"\n"
	l, ok = ParseLimits([]byte(inProgress))
	if !ok || l.LastMSN != 101 || l.PartsPerSegment != 4 {
		t.Fatalf("in-progress limits %+v", l)
	}
	skipped := "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-SKIP:SKIPPED-SEGMENTS=3\n#EXTINF:2,\ns8.mp4\n"
	if l, ok := ParseLimits([]byte(skipped)); !ok || l.LastMSN != 8 {
		t.Fatalf("delta playlist limits %+v", l)
	}
	if _, ok := ParseLimits([]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n")); ok {
		t.Fatal("multivariant playlist has no limits")
	}
}

func TestLimitsCheck(t *testing.T) {
	l := Limits{LastMSN: 101, PartsPerSegment: 4}
	for _, c := range []struct {
		msn, part int64
		ok        bool
	}{
		{101, 3, true}, {102, 0, true}, {102, -1, true}, {50, -1, true}, {102, 4, true},
		{103, -1, false}, {103, 0, false}, {1 << 40, -1, false}, {101, 5, false}, {101, 999, false},
	} {
		err := l.Check(c.msn, c.part)
		if (err == nil) != c.ok || (err != nil && !errors.Is(err, ErrBeyondLive)) {
			t.Fatalf("Check(%d, %d) = %v, want ok=%v", c.msn, c.part, err, c.ok)
		}
	}
}

func TestParseDirectives(t *testing.T) {
	q, _ := url.ParseQuery("_HLS_part=2&_HLS_msn=10&t=x")
	d, err := ParseDirectives(q)
	if err != nil || d.Query != "_HLS_msn=10&_HLS_part=2" || d.MSN != 10 || d.Part != 2 {
		t.Fatalf("%+v %v", d, err)
	}
	d, err = ParseDirectives(url.Values{})
	if err != nil || d.Query != "" || d.MSN != -1 || d.Part != -1 {
		t.Fatalf("%+v %v", d, err)
	}
	if _, err := ParseDirectives(url.Values{"_HLS_part": {"1"}}); err == nil {
		t.Fatal("part without msn accepted")
	}
}
