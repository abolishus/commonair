// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package hls

import (
	"errors"
	"math"
	"net/url"
	"strconv"
	"strings"
)

// Limits are the bounds a blocking playlist request may ask for, derived
// from the current plain playlist. Without them a client could ask the origin
// to hold a request open for a segment far in the future.
type Limits struct {
	// LastMSN is the highest media sequence number present, counting a
	// trailing in-progress segment (parts after the last EXTINF).
	LastMSN int64
	// PartsPerSegment is the most parts one segment can have.
	PartsPerSegment int64
}

// maxCount caps counts read from the playlist, far above any real segment or part count.
const maxCount = 1 << 30

// ParseLimits reads a media playlist's sequence numbers and part layout.
// It returns ok=false for playlists without a media sequence (multivariant).
func ParseLimits(body []byte) (Limits, bool) {
	var (
		seq, segments, partsNow, maxParts int64
		target, partTarget                float64
		haveSeq                           bool
	)
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			n, err := strconv.ParseInt(strings.TrimPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"), 10, 64)
			if err != nil || n < 0 {
				return Limits{}, false
			}
			seq, haveSeq = n, true
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			target, _ = strconv.ParseFloat(strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:"), 64)
		case strings.HasPrefix(line, "#EXT-X-PART-INF:"):
			partTarget = attrFloat(line, "PART-TARGET")
		case strings.HasPrefix(line, "#EXT-X-SKIP:"):
			// Bounded so a malformed tag cannot wrap the sequence arithmetic below.
			if n := attrFloat(line, "SKIPPED-SEGMENTS"); n > 0 && n < maxCount {
				segments += int64(n)
			}
		case strings.HasPrefix(line, "#EXT-X-PART:"):
			partsNow++
		case strings.HasPrefix(line, "#EXTINF:"):
			segments++
			maxParts = max(maxParts, partsNow)
			partsNow = 0
		}
	}
	if !haveSeq {
		return Limits{}, false
	}
	if seq > math.MaxInt64-segments-1 {
		return Limits{}, false
	}
	last := seq + segments - 1
	if partsNow > 0 {
		last++ // parts of the segment being produced
	}
	maxParts = max(maxParts, partsNow)
	if partTarget > 0 && target > 0 {
		// A huge ratio would convert to a negative int64 and switch the part check off.
		if r := math.Ceil(target / partTarget); r < maxCount {
			maxParts = max(maxParts, int64(r))
		}
	}
	return Limits{LastMSN: last, PartsPerSegment: maxParts}, true
}

func attrFloat(line, name string) float64 {
	for _, kv := range strings.Split(line[strings.IndexByte(line, ':')+1:], ",") {
		if k, v, ok := strings.Cut(kv, "="); ok && strings.TrimSpace(k) == name {
			f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
			if err == nil {
				return f
			}
		}
	}
	return 0
}

// ErrBeyondLive means a blocking request names a segment or part the stream
// cannot produce soon; LL-HLS servers answer such requests with 400.
var ErrBeyondLive = errors.New("_HLS_msn/_HLS_part beyond the live edge")

// Check accepts _HLS_msn up to one past the newest segment present (the
// next one to start) and _HLS_part up to the parts a segment can hold.
func (l Limits) Check(msn, part int64) error {
	if msn > l.LastMSN+1 {
		return ErrBeyondLive
	}
	if part >= 0 && l.PartsPerSegment > 0 && part > l.PartsPerSegment {
		return ErrBeyondLive
	}
	return nil
}

// Directives are validated LL-HLS delivery directives.
type Directives struct {
	// Query is the canonical pass-through query ("" when none).
	Query string
	// MSN and Part are -1 when absent.
	MSN, Part int64
}

// ParseDirectives validates the directives in q (see BlockingQuery).
func ParseDirectives(q url.Values) (Directives, error) {
	query, err := BlockingQuery(q)
	if err != nil {
		return Directives{}, err
	}
	d := Directives{Query: query, MSN: -1, Part: -1}
	if v := q.Get("_HLS_msn"); v != "" {
		d.MSN, _ = strconv.ParseInt(v, 10, 64)
	}
	if v := q.Get("_HLS_part"); v != "" {
		d.Part, _ = strconv.ParseInt(v, 10, 64)
	}
	return d, nil
}
