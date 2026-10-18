// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package relay ties the member relay together: identity, registration,
// heartbeats, the viewer-facing server, accounting and receipt delivery.
package relay

import (
	"context"
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
}

// Defaults when the API omits or sends out-of-range intervals.
const (
	defaultReceiptInterval   = 60 * time.Second
	defaultHeartbeatInterval = 15 * time.Second
	meterInterval            = 5 * time.Second
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
	queue, problems := receipts.OpenQueue(filepath.Join(opts.DataDir, "receipts"), opts.MaxPending)
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
	r.cancel = cancel
	r.wg.Add(2)
	go func() { defer r.wg.Done(); r.sender.Run(ctx) }()
	go func() { defer r.wg.Done(); r.control(ctx) }()
}

// Drain makes /healthz report draining and refuses new viewer requests.
func (r *Relay) Drain() { r.srv.Drain() }

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
	r.srv.Drain()
	if r.cancel != nil {
		r.cancel()
	}
	r.wg.Wait()
	r.srv.Close()
	r.closePeriod(time.Now())
	err := r.sender.SendAll(ctx)
	if n := r.queue.Len(); n > 0 {
		r.log.Warn("receipts left for the next start", "pending", n)
	}
	return err
}

func (r *Relay) control(ctx context.Context) {
	if !r.registerUntilDone(ctx) {
		return
	}
	r.heartbeat(ctx)
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
			if r.heartbeat(ctx) {
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
		err := r.register(ctx)
		if err == nil {
			return true
		}
		if ctx.Err() != nil {
			return false
		}
		wait := time.Duration(float64(backoff) * (0.8 + 0.4*rand.Float64()))
		r.log.Error("registration failed; retrying", "err", err.Error(), "retryIn", wait.String())
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

// heartbeat reports load and applies the returned status and key. It returns
// true if the API did not know the relay and it registered again.
func (r *Relay) heartbeat(ctx context.Context) bool {
	hctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := r.api.Heartbeat(hctx, apiclient.HeartbeatRequest{
		ActiveViewers: r.viewers.Count(time.Now()),
		EgressMbps:    math.Round(r.meter.Mbps()*1000) / 1000,
		CacheBytes:    r.store.LRU.Bytes(),
	})
	if err != nil {
		if apiErr, ok := apiclient.AsError(err); ok && apiErr.Unknown() {
			r.log.Warn("api does not recognize this relay; registering again", "status", apiErr.Status)
			if err := r.register(ctx); err != nil {
				r.log.Error("re-registration failed", "err", err.Error())
				return false
			}
			return true
		}
		if ctx.Err() == nil {
			r.log.Warn("heartbeat failed", "err", err.Error())
		}
		return false
	}
	st := r.srv.State()
	if st == nil {
		return false
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
		r.log.Info("relay status changed", "from", st.Status, "to", next.Status)
	}
	r.srv.SetState(&next)
	return false
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
