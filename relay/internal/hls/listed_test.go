// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package hls

import (
	"errors"
	"net/url"
	"testing"
	"time"
)

const vod = "dvr/01890000-0000-7000-8000-000000000009"

func TestListDvrPlaylist(t *testing.T) {
	pull, _ := url.Parse("https://origin.test/relay-pull/")
	body := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:10\n" +
		"#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-PROGRAM-DATE-TIME:2026-11-01T00:00:00.000Z\n" +
		"#EXTINF:4.000000,\nseg10.mp4\n#EXTINF:3.500000,\nseg11.mp4?x=1\n"
	l, err := Rewriter{PullBase: pull}.List([]byte(body), vod+"/index.m3u8", vod)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range []string{vod + "/init.mp4", vod + "/seg10.mp4", vod + "/seg11.mp4"} {
		if !l.Objects[o] {
			t.Fatalf("%s not listed: %v", o, l.Objects)
		}
	}
	if len(l.Objects) != 3 || l.Span != 7500*time.Millisecond {
		t.Fatalf("%v %v", l.Objects, l.Span)
	}
}

func TestListRefusesURIsOutsideScope(t *testing.T) {
	pull, _ := url.Parse("https://origin.test/relay-pull/")
	for _, body := range []string{
		"#EXTM3U\n#EXTINF:4,\n../other/seg.mp4\n",
		"#EXTM3U\n#EXTINF:4,\nhttps://evil.test/relay-pull/" + vod + "/seg.mp4\n",
		"#EXTM3U\n#EXT-X-MAP:URI=\"/live/alice/init.mp4\"\n",
		"#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\n",
	} {
		if _, err := (Rewriter{PullBase: pull}).List([]byte(body), vod+"/index.m3u8", vod); !errors.Is(err, ErrBadPlaylist) {
			t.Fatalf("accepted %q: %v", body, err)
		}
	}
}
