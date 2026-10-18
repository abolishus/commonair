// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package hls validates relay request paths and rewrites origin playlists so
// every media URI stays on this relay and carries the viewer's token.
package hls

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
)

// segmentRE is the allowed alphabet for one path segment. MediaMTX names
// (index.m3u8, <id>_seg12.mp4, init.mp4, rendition directories) all fit.
var segmentRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// MaxPathSegments bounds request path depth (live/<slug>/<rendition>/<file> is 4).
const MaxPathSegments = 8

// ValidPath reports whether p (for example "live/alice/index.m3u8") is a clean
// relative path of safe segments: no "..", no empty segments, no encoding tricks.
func ValidPath(p string) bool {
	if p == "" || len(p) > 512 {
		return false
	}
	segs := strings.Split(p, "/")
	if len(segs) > MaxPathSegments {
		return false
	}
	for _, s := range segs {
		if !segmentRE.MatchString(s) || strings.Contains(s, "..") {
			return false
		}
	}
	return true
}

// IsPlaylist reports whether the request is for a playlist rather than media.
func IsPlaylist(p string) bool { return strings.HasSuffix(p, ".m3u8") }

// Rewriter maps URIs found in a playlist pulled from the origin back onto the
// relay's /hls/ namespace.
type Rewriter struct {
	// PullBase is the origin's relay-pull root, e.g. https://origin/relay-pull/
	PullBase *url.URL
}

// ErrBadPlaylist means the origin returned something the relay will not serve.
var ErrBadPlaylist = errors.New("invalid playlist from origin")

// Rewrite rewrites body, the playlist at playlistPath (relative to the pull
// root), so every URI is relative to that playlist, stays within scope (the
// token's path) and carries t=token exactly once. Unknown tags pass through
// unchanged; only the URI attribute and URI lines are touched.
func (rw Rewriter) Rewrite(body []byte, playlistPath, scope, token string) ([]byte, error) {
	base, err := rw.PullBase.Parse(playlistPath)
	if err != nil {
		return nil, err
	}
	ctx := rewriteCtx{rw: rw, base: base, dir: path.Dir(playlistPath), scope: scope, token: token}

	lines := strings.Split(string(body), "\n")
	var out bytes.Buffer
	out.Grow(len(body) + len(lines)*(len(token)+4))
	sawHeader := false
	for i, line := range lines {
		line = strings.TrimSuffix(line, "\r")
		switch {
		case line == "":
		case !sawHeader:
			if strings.TrimPrefix(line, "\ufeff") != "#EXTM3U" {
				return nil, fmt.Errorf("%w: missing #EXTM3U", ErrBadPlaylist)
			}
			line = "#EXTM3U"
			sawHeader = true
		case strings.HasPrefix(line, "#EXT"):
			if line, err = ctx.rewriteTag(line); err != nil {
				return nil, err
			}
		case strings.HasPrefix(line, "#"):
			// Comment.
		default:
			if line, err = ctx.rewriteURI(strings.TrimSpace(line)); err != nil {
				return nil, err
			}
		}
		out.WriteString(line)
		if i < len(lines)-1 {
			out.WriteByte('\n')
		}
	}
	if !sawHeader {
		return nil, fmt.Errorf("%w: empty", ErrBadPlaylist)
	}
	return out.Bytes(), nil
}

type rewriteCtx struct {
	rw    Rewriter
	base  *url.URL
	dir   string
	scope string
	token string
}

// rewriteTag rewrites the value of every attribute named exactly URI in an
// attribute-list tag (EXT-X-MAP, EXT-X-PART, EXT-X-PRELOAD-HINT,
// EXT-X-RENDITION-REPORT, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, ...).
func (c rewriteCtx) rewriteTag(line string) (string, error) {
	colon := strings.IndexByte(line, ':')
	if colon < 0 || !strings.Contains(line, `URI="`) {
		return line, nil
	}
	var b strings.Builder
	b.WriteString(line[:colon+1])
	i := colon + 1
	for i < len(line) {
		eq := strings.IndexByte(line[i:], '=')
		if eq < 0 {
			b.WriteString(line[i:])
			break
		}
		name := strings.TrimSpace(line[i : i+eq])
		b.WriteString(line[i : i+eq+1])
		i += eq + 1
		var value string
		quoted := i < len(line) && line[i] == '"'
		if quoted {
			end := strings.IndexByte(line[i+1:], '"')
			if end < 0 {
				return "", fmt.Errorf("%w: unterminated quoted attribute", ErrBadPlaylist)
			}
			value = line[i+1 : i+1+end]
			i += end + 2
		} else {
			end := strings.IndexByte(line[i:], ',')
			if end < 0 {
				end = len(line) - i
			}
			value = line[i : i+end]
			i += end
		}
		if name == "URI" && quoted {
			rewritten, err := c.rewriteURI(value)
			if err != nil {
				return "", err
			}
			value = rewritten
		}
		if quoted {
			b.WriteByte('"')
			b.WriteString(value)
			b.WriteByte('"')
		} else {
			b.WriteString(value)
		}
		if i < len(line) && line[i] == ',' {
			b.WriteByte(',')
			i++
		}
	}
	return b.String(), nil
}

// rewriteURI resolves uri against the playlist's pull URL and re-expresses it
// relative to the playlist on the relay, with t=<token>.
func (c rewriteCtx) rewriteURI(uri string) (string, error) {
	ref, err := url.Parse(uri)
	if err != nil {
		return "", fmt.Errorf("%w: bad URI", ErrBadPlaylist)
	}
	if ref.Scheme != "" && ref.Scheme != "http" && ref.Scheme != "https" {
		// data:, skd: and similar never reach the origin; leave them alone.
		return uri, nil
	}
	abs := c.base.ResolveReference(ref)
	pull := c.rw.PullBase
	if abs.Scheme != pull.Scheme || abs.Host != pull.Host || !strings.HasPrefix(abs.Path, pull.Path) {
		return "", fmt.Errorf("%w: URI leaves the origin", ErrBadPlaylist)
	}
	target := strings.TrimPrefix(abs.Path, pull.Path)
	if !ValidPath(target) || !strings.HasPrefix(target, c.scope+"/") {
		return "", fmt.Errorf("%w: URI outside the stream", ErrBadPlaylist)
	}
	rel := relative(c.dir, target)
	q := withoutToken(abs.RawQuery)
	if q != "" {
		q += "&"
	}
	return rel + "?" + q + "t=" + url.QueryEscape(c.token), nil
}

// relative expresses target relative to directory fromDir (both clean,
// slash-separated, relative to the same root).
func relative(fromDir, target string) string {
	from := strings.Split(fromDir, "/")
	if fromDir == "." || fromDir == "" {
		from = nil
	}
	to := strings.Split(target, "/")
	common := 0
	for common < len(from) && common < len(to)-1 && from[common] == to[common] {
		common++
	}
	return strings.Repeat("../", len(from)-common) + strings.Join(to[common:], "/")
}

// withoutToken drops any t= the origin may have left so the viewer's token
// appears exactly once.
func withoutToken(raw string) string {
	if raw == "" {
		return ""
	}
	kept := make([]string, 0, 4)
	for _, kv := range strings.Split(raw, "&") {
		if kv == "" || kv == "t" || strings.HasPrefix(kv, "t=") {
			continue
		}
		kept = append(kept, kv)
	}
	return strings.Join(kept, "&")
}

// BlockingQuery extracts the LL-HLS delivery directives the relay passes
// through to the origin (_HLS_msn, _HLS_part, _HLS_skip), validated and in
// canonical order so identical requests share one cache key and one fetch.
func BlockingQuery(q url.Values) (string, error) {
	var parts []string
	msn := q.Get("_HLS_msn")
	part := q.Get("_HLS_part")
	skip := q.Get("_HLS_skip")
	if msn != "" {
		if !isUint(msn) {
			return "", errors.New("_HLS_msn must be a non-negative integer")
		}
		parts = append(parts, "_HLS_msn="+msn)
	}
	if part != "" {
		if msn == "" {
			return "", errors.New("_HLS_part requires _HLS_msn")
		}
		if !isUint(part) {
			return "", errors.New("_HLS_part must be a non-negative integer")
		}
		parts = append(parts, "_HLS_part="+part)
	}
	if skip != "" {
		if skip != "YES" && skip != "v2" {
			return "", errors.New("_HLS_skip must be YES or v2")
		}
		parts = append(parts, "_HLS_skip="+skip)
	}
	return strings.Join(parts, "&"), nil
}

func isUint(s string) bool {
	if s == "" || len(s) > 18 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
