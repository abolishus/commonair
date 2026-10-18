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
	"sync"
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
	// MaxOriginFetches bounds distinct origin fetches in flight at once;
	// beyond it viewers get 503 instead of the relay queueing without limit.
	MaxOriginFetches int
	// MaxRequestsPerSession bounds one viewer session's concurrent requests.
	// An LL-HLS player needs a blocking playlist reload, a part or two and a
	// rendition report at most; more means a misbehaving or abusive client.
	MaxRequestsPerSession int
}

// Defaults for Config; exported so the command can size its shutdown window.
const (
	DefaultPlaylistTimeout       = 20 * time.Second
	DefaultMediaTimeout          = 30 * time.Second
	DefaultMaxOriginFetches      = 256
	DefaultMaxRequestsPerSession = 8
)

// Server handles viewer requests.
type Server struct {
	cfg      Config
	state    atomic.Pointer[State]
	draining atomic.Bool
	// fetchCtx parents origin fetches; cancelled when the relay stops.
	fetchCtx    context.Context
	cancelFetch context.CancelFunc
	fetchSlots  chan struct{}

	sessMu   sync.Mutex
	sessReqs map[string]int

	inflight sync.WaitGroup
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
		cfg.PlaylistTimeout = DefaultPlaylistTimeout
	}
	if cfg.MediaTimeout <= 0 {
		cfg.MediaTimeout = DefaultMediaTimeout
	}
	if cfg.MaxOriginFetches <= 0 {
		cfg.MaxOriginFetches = DefaultMaxOriginFetches
	}
	if cfg.MaxRequestsPerSession <= 0 {
		cfg.MaxRequestsPerSession = DefaultMaxRequestsPerSession
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{
		cfg: cfg, fetchCtx: ctx, cancelFetch: cancel,
		fetchSlots: make(chan struct{}, cfg.MaxOriginFetches),
		sessReqs:   map[string]int{},
	}
}

// WaitIdle blocks until no handler is running or ctx ends. After the HTTP
// server is closed, handlers still finishing their last write would
// otherwise add bytes after the final receipt period was cut.
func (s *Server) WaitIdle(ctx context.Context) error {
	done := make(chan struct{})
	go func() { s.inflight.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// enterSession counts a request against its session's cap.
func (s *Server) enterSession(sid string) bool {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	if s.sessReqs[sid] >= s.cfg.MaxRequestsPerSession {
		return false
	}
	s.sessReqs[sid]++
	return true
}

func (s *Server) leaveSession(sid string) {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	if s.sessReqs[sid] <= 1 {
		delete(s.sessReqs, sid)
		return
	}
	s.sessReqs[sid]--
}

// errBusy means the global origin fetch budget is exhausted.
var errBusy = errors.New("too many origin fetches in flight")

// limitedFetch runs an origin fetch if a slot is free, bounded by timeout,
// the coalesced call's context (cancelled when no viewer waits any more) and
// the server's lifetime.
func (s *Server) limitedFetch(callCtx context.Context, timeout time.Duration, fetch func(context.Context) (cache.Entry, error)) (cache.Entry, error) {
	select {
	case s.fetchSlots <- struct{}{}:
	default:
		return cache.Entry{}, errBusy
	}
	defer func() { <-s.fetchSlots }()
	ctx, cancel := context.WithTimeout(callCtx, timeout)
	defer cancel()
	stop := context.AfterFunc(s.fetchCtx, cancel)
	defer stop()
	return fetch(ctx)
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
	h := securityHeaders(mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.inflight.Add(1)
		defer s.inflight.Done()
		h.ServeHTTP(w, r)
	})
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
	if !s.enterSession(claims.SID) {
		w.Header().Set("Retry-After", "1")
		httpError(w, http.StatusTooManyRequests, "too many concurrent requests for this session")
		return
	}
	defer s.leaveSession(claims.SID)
	if hls.IsPlaylist(p) {
		s.servePlaylist(w, r, st, claims, p, token, q)
		return
	}
	s.serveMedia(w, r, st, claims, p)
}

func (s *Server) servePlaylist(w http.ResponseWriter, r *http.Request, st *State, c tokens.PlaybackClaims, p, token string, q url.Values) {
	d, err := hls.ParseDirectives(q)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	var entry cache.Entry
	if d.Query == "" {
		entry, err = s.playlist(r.Context(), st, p, "", s.cfg.PlaylistTTL)
	} else {
		entry, err = s.blockingPlaylist(r.Context(), st, p, d)
	}
	if errors.Is(err, hls.ErrBeyondLive) {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
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
	// Playlist bytes are deliberately not counted: receipts are media-only
	// (see internal/receipts) to match the origin's issuance ground truth.
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
}

// playlist returns the playlist at p (with optional directives query) from
// cache or the origin.
func (s *Server) playlist(ctx context.Context, st *State, p, query string, ttl time.Duration) (cache.Entry, error) {
	rel := p
	if query != "" {
		rel = p + "?" + query
	}
	return s.cfg.Store.Get(ctx, "pl:"+rel, func(callCtx context.Context) (cache.Entry, error) {
		return s.limitedFetch(callCtx, s.cfg.PlaylistTimeout, func(fctx context.Context) (cache.Entry, error) {
			e, err := s.fetchOrigin(fctx, st.PullBase, rel, maxPlaylistBytes)
			if err == nil {
				e = cache.WithTTL(e, ttl)
			}
			return e, err
		})
	})
}

// blockingPlaylist checks the requested msn/part against the current plain
// playlist before asking the origin to hold a request open for it.
func (s *Server) blockingPlaylist(ctx context.Context, st *State, p string, d hls.Directives) (cache.Entry, error) {
	if d.MSN >= 0 {
		plain, err := s.playlist(ctx, st, p, "", s.cfg.PlaylistTTL)
		if err != nil {
			return cache.Entry{}, err
		}
		if limits, ok := hls.ParseLimits(plain.Body); ok {
			if err := limits.Check(d.MSN, d.Part); err != nil {
				return cache.Entry{}, err
			}
		}
	}
	return s.playlist(ctx, st, p, d.Query, s.cfg.BlockingPlaylistTTL)
}

func (s *Server) serveMedia(w http.ResponseWriter, r *http.Request, st *State, c tokens.PlaybackClaims, p string) {
	entry, err := s.cfg.Store.Get(r.Context(), "m:"+p, func(callCtx context.Context) (cache.Entry, error) {
		return s.limitedFetch(callCtx, s.cfg.MediaTimeout, func(fctx context.Context) (cache.Entry, error) {
			return s.fetchOrigin(fctx, st.PullBase, p, maxMediaBytes)
		})
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
	case errors.Is(err, errBusy):
		w.Header().Set("Retry-After", "1")
		httpError(w, http.StatusServiceUnavailable, "relay busy")
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
