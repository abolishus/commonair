// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package hls

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Listing is what a media playlist lists: the objects a relay may serve while
// that playlist is current, and how much media it spans.
type Listing struct {
	// Objects are pull-root-relative paths ("dvr/<vodId>/seg12.mp4"), init
	// segments (EXT-X-MAP) included.
	Objects map[string]bool
	// Span is the sum of the EXTINF durations.
	Span time.Duration
}

// List reads the media playlist at playlistPath (relative to the pull root)
// as the origin sent it. Every URI must resolve inside scope, as Rewrite
// requires; anything else makes the playlist unusable.
func (rw Rewriter) List(body []byte, playlistPath, scope string) (Listing, error) {
	base, err := rw.PullBase.Parse(playlistPath)
	if err != nil {
		return Listing{}, err
	}
	out := Listing{Objects: map[string]bool{}}
	add := func(uri string) error {
		ref, err := url.Parse(uri)
		if err != nil {
			return fmt.Errorf("%w: bad URI", ErrBadPlaylist)
		}
		abs := base.ResolveReference(ref)
		pull := rw.PullBase
		if abs.Scheme != pull.Scheme || abs.Host != pull.Host || !strings.HasPrefix(abs.Path, pull.Path) {
			return fmt.Errorf("%w: URI leaves the origin", ErrBadPlaylist)
		}
		target := strings.TrimPrefix(abs.Path, pull.Path)
		if !ValidPath(target) || !strings.HasPrefix(target, scope+"/") {
			return fmt.Errorf("%w: URI outside the stream", ErrBadPlaylist)
		}
		out.Objects[target] = true
		return nil
	}
	var span float64
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
		case strings.HasPrefix(line, "#EXTINF:"):
			v := strings.TrimPrefix(line, "#EXTINF:")
			if i := strings.IndexByte(v, ','); i >= 0 {
				v = v[:i]
			}
			if d, err := strconv.ParseFloat(v, 64); err == nil && d > 0 && d < 3600 {
				span += d
			}
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			_, rest, ok := strings.Cut(line, `URI="`)
			if !ok {
				continue
			}
			uri, _, ok := strings.Cut(rest, `"`)
			if !ok {
				return Listing{}, fmt.Errorf("%w: unterminated quoted attribute", ErrBadPlaylist)
			}
			if err := add(uri); err != nil {
				return Listing{}, err
			}
		case strings.HasPrefix(line, "#"):
		default:
			if err := add(line); err != nil {
				return Listing{}, err
			}
		}
	}
	out.Span = time.Duration(span * float64(time.Second))
	return out, nil
}
