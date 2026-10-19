// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package relay ties the member relay together: identity, registration,
// heartbeats, the viewer-facing server, accounting and receipt delivery.
package relay

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/abolishus/commonair/relay/internal/accounting"
	"github.com/abolishus/commonair/relay/internal/apiclient"
	"github.com/abolishus/commonair/relay/internal/cache"
	"github.com/abolishus/commonair/relay/internal/identity"
	"github.com/abolishus/commonair/relay/internal/receipts"
	"github.com/abolishus/commonair/relay/internal/server"
	"github.com/abolishus/commonair/relay/internal/tokens"
)

// Options configures a relay. Zero durations take production defaults or
// the values the API returns at registration.
type Options struct {
	APIURL        string
	Token         string
	PublicURL     string
	Region        string
	CapacityMbps  int
	PerViewerMbps float64
	DataDir       string
	CacheBytes    int64
	MaxPending    int
	Version       string
	Log           *slog.Logger

	APIClient    *http.Client
	OriginClient *http.Client

	// Overrides for the API-provided intervals (tests, debugging).
	ReceiptInterval   time.Duration
	HeartbeatInterval time.Duration
	// Retry bounds for registration and receipt delivery.
	RetryMin time.Duration
	RetryMax time.Duration
}

// Relay is a running relay node.
type Relay struct {
	opts    Options
	log     *slog.Logger
	key     identity.Key
	api     *apiclient.Client
	srv     *server.Server
	store   *cache.Store
	ledger  *accounting.Ledger
	viewers *accounting.Viewers
	meter   *accounting.Meter
	queue   *receipts.Queue
	sender  *receipts.Sender

	mu                sync.Mutex
	receiptInterval   time.Duration
	heartbeatInterval time.Duration

	cancel  context.CancelFunc
	wg      sync.WaitGroup
	stopped bool

	// hbMu serializes registration and heartbeats with the draining
	// heartbeat, so no normal heartbeat (or re-registration) lands after it.
	// It is held across API calls; never take it just to read state.
	hbMu     sync.Mutex
	draining atomic.Bool
	// hbCancel ends the context bounding registration and normal heartbeats.
	// BeginDrain calls it without hbMu, so a call in flight against a slow
	// API gives way at once instead of delaying the draining heartbeat.
	hbCancel atomic.Pointer[context.CancelFunc]
}

// Defaults when the API omits or sends out-of-range intervals.
const (
	defaultReceiptInterval   = 60 * time.Second
	defaultHeartbeatInterval = 15 * time.Second
	meterInterval            = 5 * time.Second
	// MaxOriginConns caps TCP connections to the origin host.
	MaxOriginConns = 128
)

// New loads (or creates) the identity and prepares every component. It does
// not touch the network; call Start.
func New(opts Options) (*Relay, error) {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Version == "" {
		opts.Version = "dev"
	}
	if opts.CapacityMbps < 1 || opts.CapacityMbps > 100_000 {
		return nil, errors.New("capacity must be between 1 and 100000 Mbps")
	}
	if opts.CacheBytes <= 0 {
		opts.CacheBytes = 1024 << 20
	}
	if opts.RetryMin <= 0 {
		opts.RetryMin = time.Second
	}
	if opts.RetryMax <= 0 {
		opts.RetryMax = time.Minute
	}
	if err := validatePublicURL(opts.PublicURL); err != nil {
		return nil, err
	}
	if opts.Token == "" {
		return nil, errors.New("a relay registration token is required")
	}
	if opts.OriginClient == nil {
		opts.OriginClient = &http.Client{Transport: originTransport()}
	}
	api, err := apiclient.New(opts.APIURL, opts.Token, opts.Version, opts.APIClient)
	if err != nil {
		return nil, err
	}
	key, err := identity.LoadOrCreate(opts.DataDir)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS != "windows" && identity.Insecure(opts.DataDir) {
		opts.Log.Warn("relay key file is readable by other users; run chmod 600", "file", filepath.Join(opts.DataDir, identity.KeyFile))
	}
	pub, _ := key.Private.Public().(ed25519.PublicKey)
	queue, problems := receipts.OpenQueue(filepath.Join(opts.DataDir, "receipts"), opts.MaxPending, pub)
	for _, p := range problems {
		opts.Log.Warn("receipt queue problem", "err", p.Error())
	}
	r := &Relay{
		opts:    opts,
		log:     opts.Log,
		key:     key,
		api:     api,
		store:   cache.NewStore(opts.CacheBytes),
		ledger:  accounting.NewLedger(time.Now()),
		viewers: accounting.NewViewers(accounting.MaxViewers(opts.CapacityMbps, opts.PerViewerMbps)),
		meter:   accounting.NewMeter(30 * time.Second),
		queue:   queue,
	}
	r.sender = &receipts.Sender{Queue: queue, API: api, Log: opts.Log, MinBackoff: opts.RetryMin, MaxBackoff: opts.RetryMax}
	r.srv = server.New(server.Config{
		Version:   opts.Version,
		PullToken: opts.Token,
		Origin:    opts.OriginClient,
		Store:     r.store,
		Ledger:    r.ledger,
		Viewers:   r.viewers,
		Log:       opts.Log,
	})
	if key.Created {
		opts.Log.Info("generated relay identity", "publicKey", key.PublicB64)
	}
	return r, nil
}

func validatePublicURL(s string) error {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("--public-url must be an http(s) URL without query or fragment")
	}
	return nil
}

func originTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConnsPerHost = 64
	// Hard cap on connections to the origin; together with the server's
	// fetch budget this bounds what one relay can ask of the origin.
	t.MaxConnsPerHost = MaxOriginConns
	t.ResponseHeaderTimeout = 0 // blocking playlist requests are held on purpose; contexts bound them
	t.IdleConnTimeout = 90 * time.Second
	return t
}

// Handler is the viewer-facing HTTP handler.
func (r *Relay) Handler() http.Handler { return r.srv.Handler() }

// PublicKey is the relay's receipt key (base64url).
func (r *Relay) PublicKey() string { return r.key.PublicB64 }

// Start launches registration, heartbeats, receipts and delivery in the
// background. Serve Handler before calling it: the API health-checks
// /healthz during registration.
func (r *Relay) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	hbCtx, hbCancel := context.WithCancel(ctx)
	r.cancel = cancel
	r.hbCancel.Store(&hbCancel)
	if r.draining.Load() {
		hbCancel() // drained before Start: never register
	}
	r.wg.Add(2)
	go func() { defer r.wg.Done(); r.sender.Run(ctx) }()
	go func() { defer r.wg.Done(); r.control(ctx, hbCtx) }()
}

// MinDrainWindow is the shortest drain GracefulStop accepts: players move to
// the origin on their next playback heartbeat (10 s), and a blocking playlist
// reload in flight when the window closes gets time to finish.
const MinDrainWindow = server.DefaultPlaylistTimeout + 5*time.Second

// handlerGrace bounds the wait for handlers after the HTTP server is closed.
const handlerGrace = 3 * time.Second

// drainHeartbeatTimeout bounds the one draining heartbeat.
const drainHeartbeatTimeout = 5 * time.Second

// maxCloseGrace is the end of the drain window reserved for closing the HTTP
// server: in-flight requests finish, idle connections close.
const maxCloseGrace = 5 * time.Second

// BeginDrain takes the relay out of assignment: /healthz reports draining,
// normal heartbeats stop, only viewers already here keep being served, and one
// heartbeat with draining: true tells the API (best effort, bounded by
// timeout). Receipts keep being cut until Shutdown.
func (r *Relay) BeginDrain(timeout time.Duration) {
	if r.draining.Swap(true) {
		return
	}
	r.srv.Drain()
	if cancelHB := r.hbCancel.Load(); cancelHB != nil {
		(*cancelHB)() // a registration or heartbeat in flight gives way
	}
	r.hbMu.Lock()
	defer r.hbMu.Unlock()
	if r.srv.State() == nil {
		r.log.Info("draining before registration; nothing to report")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	resp, err := r.api.Heartbeat(ctx, r.load(true))
	if err != nil {
		r.log.Warn("draining heartbeat failed; the platform takes the relay out when its health check fails", "err", err.Error())
		return
	}
	r.log.Info("draining: out of assignment, serving current viewers", "status", resp.Status, "viewers", r.viewers.Count(time.Now()))
}

// GracefulStop is the SIGTERM sequence. It reports draining, keeps serving
// current viewers until they leave or the drain window is nearly over, then
// closes the HTTP server (in-flight requests get the rest of the window, then
// connections are cut), and finally cuts the last period and delivers
// receipts within flush.
func (r *Relay) GracefulStop(httpSrv *http.Server, drain, flush time.Duration) error {
	start := time.Now()
	r.BeginDrain(min(drainHeartbeatTimeout, drain))
	closeGrace := min(maxCloseGrace, drain/2)
	r.waitViewersGone(start.Add(drain - closeGrace))
	closeCtx, cancel := context.WithDeadline(context.Background(), start.Add(drain))
	err := httpSrv.Shutdown(closeCtx)
	cancel()
	if err != nil {
		r.log.Warn("drain window over; closing remaining connections", "err", err.Error())
		_ = httpSrv.Close()
	}
	flushCtx, cancelFlush := context.WithTimeout(context.Background(), flush+handlerGrace)
	defer cancelFlush()
	return r.Shutdown(flushCtx)
}

// waitViewersGone returns once no viewer session is active or at deadline.
func (r *Relay) waitViewersGone(deadline time.Time) {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for time.Now().Before(deadline) && r.viewers.Count(time.Now()) > 0 {
		<-t.C
	}
}

// Shutdown stops background work, closes the final period and tries to
// deliver every queued receipt before ctx ends. Whatever is not delivered
// stays on disk for the next start. Call it after the HTTP server has
// finished in-flight requests so the final receipt includes them.
func (r *Relay) Shutdown(ctx context.Context) error {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return nil
	}
	r.stopped = true
	r.mu.Unlock()
	r.draining.Store(true)
	r.srv.Drain()
	if r.cancel != nil {
		r.cancel()
	}
	r.wg.Wait()
	r.srv.Close() // abort origin fetches so blocked handlers return promptly
	// Handlers cut off by an HTTP server Close may still be finishing their
	// last write; wait for them so their bytes land in the final period
	// instead of after it.
	idleCtx, cancelIdle := context.WithTimeout(ctx, handlerGrace)
	if err := r.srv.WaitIdle(idleCtx); err != nil {
		r.log.Warn("handlers still running at the final receipt; their remaining bytes are not reported")
	}
	cancelIdle()
	r.closePeriod(time.Now())
	err := r.sender.SendAll(ctx)
	if n := r.queue.Len(); n > 0 {
		r.log.Warn("receipts left for the next start", "pending", n)
	}
	return err
}

// control registers, then heartbeats and cuts receipt periods until ctx
// ends. hbCtx (a child of ctx) ends earlier when the relay starts draining:
// heartbeats stop, receipt periods continue.
func (r *Relay) control(ctx, hbCtx context.Context) {
	if !r.registerUntilDone(hbCtx) {
		return
	}
	r.heartbeat(hbCtx)
	r.mu.Lock()
	hb, rc := r.heartbeatInterval, r.receiptInterval
	r.mu.Unlock()
	hbT, rcT, meterT := time.NewTicker(hb), time.NewTicker(rc), time.NewTicker(meterInterval)
	defer hbT.Stop()
	defer rcT.Stop()
	defer meterT.Stop()
	r.meter.Sample(r.ledger.TotalBytes(), time.Now())
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-meterT.C:
			r.meter.Sample(r.ledger.TotalBytes(), now)
		case now := <-rcT.C:
			r.closePeriod(now)
		case <-hbT.C:
			if r.heartbeat(hbCtx) {
				// Re-registered: intervals may have changed.
				r.mu.Lock()
				hbT.Reset(r.heartbeatInterval)
				rcT.Reset(r.receiptInterval)
				r.mu.Unlock()
			}
		}
	}
}

func (r *Relay) registerUntilDone(ctx context.Context) bool {
	backoff := r.opts.RetryMin
	for {
		err := r.lockedRegister(ctx)
		if err == nil {
			return true
		}
		if ctx.Err() != nil || r.draining.Load() {
			return false
		}
		wait := time.Duration(float64(backoff) * (0.8 + 0.4*rand.Float64()))
		r.logRegisterError("registration failed; retrying", err, "retryIn", wait.String())
		select {
		case <-ctx.Done():
			return false
		case <-time.After(wait):
		}
		backoff = min(backoff*2, r.opts.RetryMax)
	}
}

func (r *Relay) register(ctx context.Context) error {
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := r.api.Register(rctx, apiclient.RegisterRequest{
		PublicURL:            strings.TrimSuffix(r.opts.PublicURL, "/"),
		DeclaredCapacityMbps: r.opts.CapacityMbps,
		PublicKey:            r.key.PublicB64,
		Version:              r.opts.Version,
		Region:               r.opts.Region,
	})
	if err != nil {
		return err
	}
	pull, err := pullBase(resp.OriginURL)
	if err != nil {
		return err
	}
	originKey, err := tokens.ParsePublicKey(resp.OriginPublicKey)
	if err != nil {
		return fmt.Errorf("origin public key: %w", err)
	}
	r.mu.Lock()
	r.receiptInterval = pickInterval(r.opts.ReceiptInterval, resp.ReceiptIntervalSeconds, defaultReceiptInterval, 10*time.Second, time.Hour)
	r.heartbeatInterval = pickInterval(r.opts.HeartbeatInterval, resp.HeartbeatIntervalSeconds, defaultHeartbeatInterval, time.Second, 10*time.Minute)
	r.mu.Unlock()
	prev := r.srv.State()
	if prev != nil && prev.RelayID != resp.RelayID {
		// Bytes counted so far were served under the old id; close them out first.
		r.closePeriod(time.Now())
	}
	r.srv.SetState(&server.State{RelayID: resp.RelayID, PullBase: pull, OriginKey: originKey, Status: resp.Status})
	r.log.Info("registered", "relayId", resp.RelayID, "status", resp.Status, "maxViewers", r.viewers.Max())
	return nil
}

func pullBase(originURL string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSuffix(originURL, "/") + "/relay-pull/")
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("api returned an invalid originUrl")
	}
	return u, nil
}

// pickInterval prefers an explicit override, then the API value clamped to
// [lo, hi], then the default.
func pickInterval(override time.Duration, apiSeconds int, def, lo, hi time.Duration) time.Duration {
	if override > 0 {
		return override
	}
	if apiSeconds <= 0 {
		return def
	}
	return min(max(time.Duration(apiSeconds)*time.Second, lo), hi)
}

// errDraining stops registration once the relay is draining.
var errDraining = errors.New("relay is draining")

// lockedRegister registers unless the relay is draining.
func (r *Relay) lockedRegister(ctx context.Context) error {
	r.hbMu.Lock()
	defer r.hbMu.Unlock()
	if r.draining.Load() {
		return errDraining
	}
	return r.register(ctx)
}

// logRegisterError logs a failed registration; a refused token is spelled
// out because retrying cannot fix it.
func (r *Relay) logRegisterError(msg string, err error, args ...any) {
	if apiErr, ok := apiclient.AsError(err); ok && apiErr.Status == http.StatusUnauthorized {
		r.log.Error(msg+": the API refused the relay token (the relay was retired, or the token is wrong); create a new relay to get a new token", append(args, "status", apiErr.Status)...)
		return
	}
	r.log.Error(msg, append(args, "err", err.Error())...)
}

// load is the heartbeat body.
func (r *Relay) load(draining bool) apiclient.HeartbeatRequest {
	return apiclient.HeartbeatRequest{
		ActiveViewers: r.viewers.Count(time.Now()),
		EgressMbps:    math.Round(r.meter.Mbps()*1000) / 1000,
		CacheBytes:    r.store.LRU.Bytes(),
		Draining:      draining,
	}
}

// hbAction is what the relay does with a heartbeat result.
type hbAction int

const (
	// hbApply: the API knows the relay; adopt its status and origin key.
	// Suspended is applied too: the relay keeps heartbeating and serves 410
	// so a reinstatement takes effect at the next heartbeat.
	hbApply hbAction = iota
	// hbReregister: the API took the relay offline (drained, or timed out
	// while the relay was paused or cut off), no longer recognizes it
	// (401/404) or has no registration for it (412). Register again with the
	// same token and key; a retired relay's token is refused there (401).
	hbReregister
	// hbRetry: a transient failure (network, 5xx, rate limit, other 4xx).
	// Keep the current state and try at the next interval.
	hbRetry
)

// statusOffline is the RELAY_STATUSES value for a relay out of assignment.
const statusOffline = "offline"

func classifyHeartbeat(resp apiclient.HeartbeatResponse, err error) hbAction {
	if err != nil {
		if apiErr, ok := apiclient.AsError(err); ok && (apiErr.Unknown() || apiErr.Status == http.StatusPreconditionFailed) {
			return hbReregister
		}
		return hbRetry
	}
	if resp.Status == statusOffline {
		return hbReregister
	}
	return hbApply
}

// heartbeat reports load and acts on the answer (see hbAction). It returns
// true if the relay registered again, so intervals may have changed.
func (r *Relay) heartbeat(ctx context.Context) bool {
	r.hbMu.Lock()
	defer r.hbMu.Unlock()
	if r.draining.Load() {
		return false
	}
	hctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := r.api.Heartbeat(hctx, r.load(false))
	switch classifyHeartbeat(resp, err) {
	case hbReregister:
		if apiErr, ok := apiclient.AsError(err); ok {
			r.log.Warn("api does not recognize this relay; registering again", "status", apiErr.Status)
		} else {
			r.log.Warn("api reports this relay offline; registering again")
		}
		if err := r.register(ctx); err != nil {
			if ctx.Err() == nil {
				r.logRegisterError("re-registration failed; retrying at the next heartbeat", err)
			}
			return false
		}
		return true
	case hbRetry:
		if ctx.Err() == nil {
			r.log.Warn("heartbeat failed", "err", err.Error())
		}
		return false
	}
	r.apply(resp)
	return false
}

// apply installs the status and origin key a heartbeat returned.
func (r *Relay) apply(resp apiclient.HeartbeatResponse) {
	st := r.srv.State()
	if st == nil {
		return
	}
	next := *st
	next.Status = resp.Status
	if resp.OriginPublicKey != "" {
		if k, err := tokens.ParsePublicKey(resp.OriginPublicKey); err == nil {
			next.OriginKey = k
		} else {
			r.log.Warn("heartbeat returned an unusable origin key; keeping the old one", "err", err.Error())
		}
	}
	if next.Status != st.Status {
		if next.Status == server.StatusSuspended {
			r.log.Error("relay SUSPENDED by the platform: viewers get 410 until an admin reinstates it; the reason is on your relay page", "from", st.Status)
		} else {
			r.log.Info("relay status changed", "from", st.Status, "to", next.Status)
		}
	}
	r.srv.SetState(&next)
}

// closePeriod cuts the accounting period, signs and queues its receipts.
func (r *Relay) closePeriod(now time.Time) {
	p := r.ledger.Cut(now)
	if len(p.Entries) == 0 {
		return
	}
	st := r.srv.State()
	if st == nil {
		r.log.Error("bytes served without registration; cannot attribute receipt", "entries", len(p.Entries))
		return
	}
	built, err := receipts.Build(r.key.Private, st.RelayID, p, 0)
	if err != nil {
		r.log.Error("could not sign receipt", "err", err.Error())
		return
	}
	for _, b := range built {
		dropped, err := r.queue.Add(b.Receipt, now, b.Nonce)
		if err != nil {
			r.log.Error("could not persist receipt; kept in memory only", "err", err.Error())
		}
		if len(dropped) > 0 {
			r.log.Error("receipt backlog full; dropped oldest unsent receipts", "dropped", len(dropped))
		}
	}
	var bytes int64
	for _, e := range p.Entries {
		bytes += e.Bytes
	}
	r.log.Info("receipt queued", "sessions", len(p.Entries), "bytes", bytes, "receipts", len(built))
	r.sender.Kick()
}
