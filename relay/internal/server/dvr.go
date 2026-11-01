// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/abolishus/commonair/relay/internal/cache"
	"github.com/abolishus/commonair/relay/internal/hls"
)

// Live DVR from a relay (batch 7 decision (x), ADR 0016 Amendment 1 A1.3):
//
//	GET|HEAD /dvr/<vodId>/<file>?t=<token>
//
// The token is a relay token for this relay with path dvr/<vodId> (Binding;
// a dm token never parses). The relay pulls /relay-pull/dvr/<vodId>/… from
// the origin, which applies the DVR state checks and the window cut. Removal
// reaches the relay two ways: the signed purge (purge package, PurgePrefix)
// evicts at once, and without it the relay stops serving within about 5 s:
//
//   - the playlist is re-read when the relay's copy is DvrPlaylistTTL old;
//   - a segment is served only while the current playlist lists it and the
//     last good playlist fetch is under DvrStaleAfter old, else 404;
//   - a 404 or 403 from the origin evicts the VOD's whole prefix at once.
//
// Everything is answered with `cache-control: private, no-store`. Segment
// bytes and segments count toward receipts like live media (the receipt has
// no mode field; ADR 0016 decision 6 judges relay DVR on those receipts).
const (
	DvrPlaylistTTL = time.Second
	DvrStaleAfter  = 5 * time.Second
	// dvrMinExpiry bounds a segment's cache life from below (a playlist with
	// no durations would otherwise expire segments at once).
	dvrMinExpiry = 30 * time.Second
	// dvrForgetAfter drops a VOD's playlist state nobody asked for in a while.
	dvrForgetAfter = 10 * time.Minute
)

var (
	dvrVodRE  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	dvrFileRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}\.(m3u8|mp4|m4s)$`)
)

const dvrPlaylistFile = "index.m3u8"

// validDvrPath accepts exactly dvr/<lowercase uuid>/<file>, the origin's grammar.
func validDvrPath(p string) bool {
	parts := strings.Split(p, "/")
	return len(parts) == 3 && parts[0] == "dvr" && dvrVodRE.MatchString(parts[1]) && dvrFileRE.MatchString(parts[2]) &&
		hls.ValidPath(p)
}

// dvrVod is what the relay knows of one VOD's DVR playlist.
type dvrVod struct {
	fetchedAt time.Time // the last successful playlist fetch
	listed    map[string]bool
	expiry    time.Duration // segment cache life: the playlist's span
	usedAt    time.Time
}

func dvrPrefix(vodID string) string { return "dvr/" + vodID + "/" }

func (s *Server) dvr(w http.ResponseWriter, r *http.Request) {
	v, ok := s.admit(w, r, "/dvr/", "/", validDvrPath)
	if !ok {
		return
	}
	defer v.done()
	h := w.Header()
	parts := strings.Split(v.path, "/")
	vodID, file := parts[1], parts[2]
	// Purged within TombstoneTTL: the origin's state cache may still answer
	// for a few seconds, so the relay does not ask it.
	if s.cfg.Store.Tombstoned(v.path) {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if strings.HasSuffix(file, ".m3u8") {
		if file != dvrPlaylistFile {
			httpError(w, http.StatusNotFound, "not found")
			return
		}
		entry, err := s.dvrPlaylist(r.Context(), v.st, vodID)
		if err != nil {
			s.originFailure(w, r, v.path, err)
			return
		}
		body, err := hls.Rewriter{PullBase: v.st.PullBase}.Rewrite(entry.Body, v.path, v.claims.Path, v.token)
		if err != nil {
			s.cfg.Log.Warn("origin DVR playlist rejected", "path", v.path, "err", err.Error())
			httpError(w, http.StatusBadGateway, "bad playlist from origin")
			return
		}
		h.Set("Content-Type", "application/vnd.apple.mpegurl")
		h.Set("Cache-Control", "private, no-store")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
		return
	}

	expiry, listed := s.dvrListed(r.Context(), v.st, vodID, v.path)
	if !listed {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	entry, err := s.cfg.Store.Get(r.Context(), "m:"+v.path, func(callCtx context.Context) (cache.Entry, error) {
		return s.limitedFetch(callCtx, s.cfg.MediaTimeout, func(fctx context.Context) (cache.Entry, error) {
			e, err := s.fetchOrigin(fctx, v.st.PullBase, v.path, maxMediaBytes)
			if err == nil {
				e.Expires = s.cfg.Now().Add(expiry)
			} else {
				s.dvrOriginRefused(vodID, err)
			}
			return e, err
		})
	})
	if err != nil {
		s.originFailure(w, r, v.path, err)
		return
	}
	h.Set("Content-Type", "video/mp4")
	h.Set("Cache-Control", "private, no-store")
	cw := &countingWriter{ResponseWriter: w, rc: http.NewResponseController(w), onBytes: func(n int64) { s.cfg.Ledger.AddBytes(v.claims.SID, n) }}
	http.ServeContent(cw, r, "", time.Time{}, bytes.NewReader(entry.Body))
	if r.Method == http.MethodGet && cw.status == http.StatusOK && cw.err == nil && cw.flushed == int64(len(entry.Body)) {
		s.cfg.Ledger.AddSegment(v.claims.SID)
	}
}

// dvrPlaylist returns the VOD's DVR playlist as the origin sent it, from a
// copy at most DvrPlaylistTTL old. A successful fetch records what it lists.
func (s *Server) dvrPlaylist(ctx context.Context, st *State, vodID string) (cache.Entry, error) {
	p := dvrPrefix(vodID) + dvrPlaylistFile
	return s.cfg.Store.Get(ctx, "pl:"+p, func(callCtx context.Context) (cache.Entry, error) {
		return s.limitedFetch(callCtx, s.cfg.PlaylistTimeout, func(fctx context.Context) (cache.Entry, error) {
			e, err := s.fetchOrigin(fctx, st.PullBase, p, maxPlaylistBytes)
			if err != nil {
				s.dvrOriginRefused(vodID, err)
				return e, err
			}
			listing, err := hls.Rewriter{PullBase: st.PullBase}.List(e.Body, p, "dvr/"+vodID)
			if err != nil {
				return cache.Entry{}, err
			}
			now := s.cfg.Now()
			s.dvrMu.Lock()
			for id, d := range s.dvrVods {
				if now.Sub(d.usedAt) > dvrForgetAfter {
					delete(s.dvrVods, id)
				}
			}
			s.dvrVods[vodID] = &dvrVod{fetchedAt: now, listed: listing.Objects, expiry: max(listing.Span, dvrMinExpiry), usedAt: now}
			s.dvrMu.Unlock()
			e.Expires = now.Add(DvrPlaylistTTL)
			return e, nil
		})
	})
}

// dvrListed reports whether the current playlist lists p and was fetched
// under DvrStaleAfter ago, refreshing it first when it is DvrPlaylistTTL old.
// It also returns the segment cache life.
func (s *Server) dvrListed(ctx context.Context, st *State, vodID, p string) (time.Duration, bool) {
	now := s.cfg.Now()
	s.dvrMu.Lock()
	d := s.dvrVods[vodID]
	fresh := d != nil && now.Sub(d.fetchedAt) < DvrPlaylistTTL
	s.dvrMu.Unlock()
	if !fresh {
		// A failed refresh keeps the last good copy; the staleness rule below decides.
		_, _ = s.dvrPlaylist(ctx, st, vodID)
	}
	s.dvrMu.Lock()
	defer s.dvrMu.Unlock()
	d = s.dvrVods[vodID]
	if d == nil || s.cfg.Now().Sub(d.fetchedAt) >= DvrStaleAfter || !d.listed[p] {
		return 0, false
	}
	d.usedAt = now
	return d.expiry, true
}

// dvrOriginRefused evicts the VOD's whole prefix when the origin answers 404
// or 403: the DVR is gone (removed, ended, restricted) or not this relay's.
// No tombstone: a recording that has no segment yet also answers 404, and the
// next fetch must be free to find the first one.
func (s *Server) dvrOriginRefused(vodID string, err error) {
	var up upstreamError
	if !errors.Is(err, errNotFound) && !(errors.As(err, &up) && up.status == http.StatusForbidden) {
		return
	}
	s.forgetDvr(func(id string) bool { return id == vodID })
	prefix := dvrPrefix(vodID)
	s.cfg.Store.LRU.DeleteFunc(func(key string) bool { return strings.HasPrefix(cache.PathOf(key), prefix) })
}

func (s *Server) forgetDvr(match func(vodID string) bool) {
	s.dvrMu.Lock()
	defer s.dvrMu.Unlock()
	for id := range s.dvrVods {
		if match(id) {
			delete(s.dvrVods, id)
		}
	}
}

// PurgePrefix applies one signed purge item: every cached object under prefix
// goes at once, fills in flight are dropped, and DVR playlists it covers are
// forgotten (the next request re-reads the origin).
func (s *Server) PurgePrefix(prefix string) {
	s.cfg.Store.DeletePrefix(prefix)
	s.forgetDvr(func(id string) bool { return strings.HasPrefix(dvrPrefix(id), prefix) })
}

// PurgeAll applies a purge reset: every cached live/ and dvr/ object goes.
func (s *Server) PurgeAll() {
	s.cfg.Store.DeletePrefix("live/")
	s.cfg.Store.DeletePrefix("dvr/")
	s.forgetDvr(func(string) bool { return true })
}
