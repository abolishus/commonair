// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package server is the relay's viewer-facing HTTP surface: /hls/ (token
// checked, pull-through cached, accounted) and /healthz.
package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/abolishus/commonair/relay/internal/accounting"
	"github.com/abolishus/commonair/relay/internal/cache"
	"github.com/abolishus/commonair/relay/internal/hls"
	"github.com/abolishus/commonair/relay/internal/tokens"
)

// Relay statuses from the API (packages/contracts/src/enums.ts RELAY_STATUSES).
const (
	StatusSuspended = "suspended"
)

// State is what registration tells the relay. It is swapped atomically on
// re-registration and when heartbeats report a new status or origin key.
type State struct {
	RelayID   string
	PullBase  *url.URL // <originUrl>/relay-pull/
	OriginKey ed25519.PublicKey
	Status    string
}

// Config wires the server's collaborators.
type Config struct {
	Version   string
	PullToken string
	Origin    *http.Client
	Store     *cache.Store
	Ledger    *accounting.Ledger
	Viewers   *accounting.Viewers
	Log       *slog.Logger
	Now       func() time.Time
	// Playlist cache lifetimes. Plain reloads change every part; blocking
	// requests name a specific msn/part so they can be reused a little longer.
	PlaylistTTL         time.Duration
	BlockingPlaylistTTL time.Duration
	// Origin fetch timeouts. Blocking playlist and preload-hint requests are
	// held by the origin until the part exists, so they get more time.
	PlaylistTimeout time.Duration
	MediaTimeout    time.Duration
}

// Server handles viewer requests.
type Server struct {
	cfg      Config
	state    atomic.Pointer[State]
	draining atomic.Bool
	// fetchCtx parents origin fetches; cancelled when the relay stops.
	fetchCtx    context.Context
	cancelFetch context.CancelFunc
}

// New returns a server with sensible defaults for unset Config fields.
func New(cfg Config) *Server {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Origin == nil {
		cfg.Origin = &http.Client{}
	}
	if cfg.PlaylistTTL <= 0 {
		cfg.PlaylistTTL = 500 * time.Millisecond
	}
	if cfg.BlockingPlaylistTTL <= 0 {
		cfg.BlockingPlaylistTTL = 2 * time.Second
	}
	if cfg.PlaylistTimeout <= 0 {
		cfg.PlaylistTimeout = 20 * time.Second
	}
	if cfg.MediaTimeout <= 0 {
		cfg.MediaTimeout = 30 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{cfg: cfg, fetchCtx: ctx, cancelFetch: cancel}
}

// SetState installs registration state; nil means not registered.
func (s *Server) SetState(st *State) { s.state.Store(st) }

// State returns the current registration state (nil before registration).
func (s *Server) State() *State { return s.state.Load() }

// Drain makes the relay refuse new viewer requests (shutdown in progress).
func (s *Server) Drain() { s.draining.Store(true) }

// Close aborts outstanding origin fetches.
func (s *Server) Close() { s.cancelFetch() }

// Handler routes requests.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.healthz)
	mux.HandleFunc("/hls/", s.hls)
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { httpError(w, http.StatusNotFound, "not found") })
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func httpError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(msg + "\n"))
}

// Health is the /healthz body the origin's health check reads.
type Health struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	Viewers int    `json:"viewers"`
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	h := Health{Status: "ok", Version: s.cfg.Version, Viewers: s.cfg.Viewers.Count(s.cfg.Now())}
	code := http.StatusOK
	st := s.state.Load()
	switch {
	case s.draining.Load():
		h.Status, code = "draining", http.StatusServiceUnavailable
	case st == nil:
		h.Status = "starting"
	case st.Status == StatusSuspended:
		h.Status = StatusSuspended
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	if r.Method == http.MethodGet {
		_ = json.NewEncoder(w).Encode(h)
	}
}

func setCORS(h http.Header) {
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Range")
	h.Set("Access-Control-Expose-Headers", "Content-Length, Content-Range")
	h.Set("Access-Control-Max-Age", "86400")
}

func (s *Server) hls(w http.ResponseWriter, r *http.Request) {
	setCORS(w.Header())
	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodGet, http.MethodHead:
	default:
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		httpError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	st := s.state.Load()
	switch {
	case s.draining.Load():
		w.Header().Set("Retry-After", "5")
		httpError(w, http.StatusServiceUnavailable, "relay is shutting down")
		return
	case st == nil:
		w.Header().Set("Retry-After", "5")
		httpError(w, http.StatusServiceUnavailable, "relay is not registered yet")
		return
	case st.Status == StatusSuspended:
		httpError(w, http.StatusGone, "relay is suspended")
		return
	}

	// Encoded characters (RawPath set) are never legitimate in HLS paths.
	p := strings.TrimPrefix(r.URL.Path, "/hls/")
	if r.URL.RawPath != "" || !hls.ValidPath(p) {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	q := r.URL.Query()
	token := q.Get("t")
	if token == "" {
		httpError(w, http.StatusUnauthorized, "missing token")
		return
	}
	now := s.cfg.Now()
	claims, err := tokens.VerifyPlayback(st.OriginKey, token, now, tokens.DefaultSkew)
	if err != nil {
		httpError(w, http.StatusUnauthorized, "invalid or expired token")
		return
	}
	if err := (tokens.Binding{RelayID: st.RelayID}).Check(claims, p); err != nil {
		httpError(w, http.StatusForbidden, "token not valid for this relay or path")
		return
	}
	if !s.cfg.Viewers.Admit(claims.SID, now) {
		w.Header().Set("Retry-After", "10")
		httpError(w, http.StatusServiceUnavailable, "relay at capacity")
		return
	}
	if hls.IsPlaylist(p) {
		s.servePlaylist(w, r, st, claims, p, token, q)
		return
	}
	s.serveMedia(w, r, st, claims, p)
}

func (s *Server) servePlaylist(w http.ResponseWriter, r *http.Request, st *State, c tokens.PlaybackClaims, p, token string, q url.Values) {
	directives, err := hls.BlockingQuery(q)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	rel, ttl, timeout := p, s.cfg.PlaylistTTL, s.cfg.PlaylistTimeout
	if directives != "" {
		rel, ttl = p+"?"+directives, s.cfg.BlockingPlaylistTTL
	}
	entry, err := s.cfg.Store.Get(r.Context(), "pl:"+rel, func() (cache.Entry, error) {
		ctx, cancel := context.WithTimeout(s.fetchCtx, timeout)
		defer cancel()
		e, err := s.fetchOrigin(ctx, st.PullBase, rel, maxPlaylistBytes)
		if err == nil {
			e = cache.WithTTL(e, ttl)
		}
		return e, err
	})
	if err != nil {
		s.originFailure(w, r, p, err)
		return
	}
	body, err := hls.Rewriter{PullBase: st.PullBase}.Rewrite(entry.Body, p, c.Path, token)
	if err != nil {
		s.cfg.Log.Warn("origin playlist rejected", "path", p, "err", err.Error())
		httpError(w, http.StatusBadGateway, "bad playlist from origin")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/vnd.apple.mpegurl")
	h.Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
}

func (s *Server) serveMedia(w http.ResponseWriter, r *http.Request, st *State, c tokens.PlaybackClaims, p string) {
	entry, err := s.cfg.Store.Get(r.Context(), "m:"+p, func() (cache.Entry, error) {
		ctx, cancel := context.WithTimeout(s.fetchCtx, s.cfg.MediaTimeout)
		defer cancel()
		return s.fetchOrigin(ctx, st.PullBase, p, maxMediaBytes)
	})
	if err != nil {
		s.originFailure(w, r, p, err)
		return
	}
	h := w.Header()
	// Known media extensions win over the origin's header so a misconfigured
	// upstream can never make the relay serve active content.
	ct := mediaType(p)
	if ct == "" {
		ct = entry.ContentType
	}
	if ct == "" || strings.Contains(strings.ToLower(ct), "html") {
		ct = "application/octet-stream"
	}
	h.Set("Content-Type", ct)
	// Segment names are unique per stream and never change.
	h.Set("Cache-Control", "private, max-age=86400, immutable")
	cw := &countingWriter{ResponseWriter: w, rc: http.NewResponseController(w), onBytes: func(n int64) { s.cfg.Ledger.AddBytes(c.SID, n) }}
	http.ServeContent(cw, r, "", time.Time{}, bytes.NewReader(entry.Body))
	if r.Method == http.MethodGet && cw.status == http.StatusOK && cw.err == nil && cw.flushed == int64(len(entry.Body)) {
		s.cfg.Ledger.AddSegment(c.SID)
	}
}

func mediaType(p string) string {
	switch {
	case strings.HasSuffix(p, ".mp4"), strings.HasSuffix(p, ".m4s"):
		return "video/mp4"
	case strings.HasSuffix(p, ".ts"):
		return "video/mp2t"
	case strings.HasSuffix(p, ".aac"):
		return "audio/aac"
	case strings.HasSuffix(p, ".vtt"):
		return "text/vtt"
	}
	return ""
}

func (s *Server) originFailure(w http.ResponseWriter, r *http.Request, p string, err error) {
	var up upstreamError
	switch {
	case r.Context().Err() != nil:
		// The viewer left; nothing to answer.
	case errors.Is(err, errNotFound):
		httpError(w, http.StatusNotFound, "not found")
	case errors.Is(err, context.DeadlineExceeded):
		s.cfg.Log.Warn("origin timeout", "path", p)
		httpError(w, http.StatusGatewayTimeout, "origin timeout")
	case errors.As(err, &up) && (up.status == http.StatusUnauthorized || up.status == http.StatusForbidden):
		s.cfg.Log.Error("origin refused relay pull; check the relay token and status", "path", p, "status", up.status)
		httpError(w, http.StatusBadGateway, "origin unavailable")
	default:
		s.cfg.Log.Warn("origin fetch failed", "path", p, "err", err.Error())
		httpError(w, http.StatusBadGateway, "origin unavailable")
	}
}

// countingWriter flushes after every write and counts only bytes whose flush
// succeeded, so a viewer that disconnects mid-segment is billed for what
// reached the socket, never more.
type countingWriter struct {
	http.ResponseWriter
	rc      *http.ResponseController
	onBytes func(int64)
	status  int
	flushed int64
	err     error
}

func (w *countingWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *countingWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if w.err != nil {
		return 0, w.err
	}
	n, err := w.ResponseWriter.Write(b)
	if err == nil {
		err = w.rc.Flush()
	}
	if err != nil {
		w.err = err
		return n, err
	}
	w.flushed += int64(n)
	w.onBytes(int64(n))
	return n, nil
}
