// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package purge follows the platform's signed purge feed (batch 7 decision
// (x), ADR 0016 Amendment 1 A1.2): a long poll of GET /api/relay/purges
// beside the heartbeat. Every answer is verified with the origin public key
// before anything in it is trusted; a bad batch is refused whole (logged and
// counted) and the cursor stays where it was. Each prefix is evicted from the
// cache at once; a reset evicts every live/ and dvr/ object.
//
// The cursor lives in memory and, when the relay has a state directory, in a
// small file there. A relay without one starts from 0 and the API answers
// with the retained rows (or a reset when they no longer reach back that far).
package purge

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/abolishus/commonair/relay/internal/tokens"
)

// StateFile is the cursor's file name in the relay's state directory.
const StateFile = "purge-seq"

// KnownReasons are RELAY_PURGE_REASONS at the time of writing. A relay
// applies any well-formed reason; unknown ones are only logged and counted.
var KnownReasons = map[string]bool{
	"vod_hidden": true, "clip_hidden": true, "restricted": true, "suspended": true, "recording_ended": true,
}

// API is the feed (apiclient.Client.Purges).
type API interface {
	Purges(ctx context.Context, after int64) (tokens.SignedPurgeBatch, error)
}

// Target applies purges (the viewer-facing server's cache).
type Target interface {
	// PurgePrefix evicts every cached object under prefix ("dvr/<vodId>/", "live/<slug>/").
	PurgePrefix(prefix string)
	// PurgeAll evicts every cached live/ and dvr/ object (a reset).
	PurgeAll()
}

// Loop polls the feed until its context ends.
type Loop struct {
	API    API
	Target Target
	// Key is the origin public key; nil until the relay has registered.
	Key func() ed25519.PublicKey
	// Dir is the state directory; empty keeps the cursor in memory only.
	Dir string
	Log *slog.Logger
	// Backoff bounds after a failed poll or a refused batch.
	MinBackoff, MaxBackoff time.Duration
	// MinInterval is the least time between two polls that brought nothing,
	// so an API that answers an empty batch at once cannot make the relay spin.
	MinInterval time.Duration
	// Sleep waits d or until ctx ends (tests replace it).
	Sleep func(ctx context.Context, d time.Duration) bool

	seq      atomic.Int64
	applied  atomic.Int64
	refused  atomic.Int64
	unknown  atomic.Int64
	resets   atomic.Int64
	failures atomic.Int64
}

// Seq is the cursor: the newest purge row this relay has applied.
func (l *Loop) Seq() int64 { return l.seq.Load() }

// Applied is the number of prefixes evicted since start.
func (l *Loop) Applied() int64 { return l.applied.Load() }

// Refused is the number of batches refused for a bad signature or shape.
func (l *Loop) Refused() int64 { return l.refused.Load() }

// UnknownReasons counts items whose reason this version does not know.
func (l *Loop) UnknownReasons() int64 { return l.unknown.Load() }

// Resets counts reset answers applied.
func (l *Loop) Resets() int64 { return l.resets.Load() }

func (l *Loop) defaults() {
	if l.Log == nil {
		l.Log = slog.Default()
	}
	if l.MinBackoff <= 0 {
		l.MinBackoff = time.Second
	}
	if l.MaxBackoff <= 0 {
		l.MaxBackoff = time.Minute
	}
	if l.MinInterval <= 0 {
		l.MinInterval = time.Second
	}
	if l.Sleep == nil {
		l.Sleep = sleep
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// Load reads the persisted cursor (0 when there is none or it is unreadable).
func (l *Loop) Load() {
	l.defaults()
	if l.Dir == "" {
		return
	}
	data, err := os.ReadFile(filepath.Join(l.Dir, StateFile))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			l.Log.Warn("purge cursor unreadable; starting from 0", "err", err.Error())
		}
		return
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || n < 0 {
		l.Log.Warn("purge cursor corrupt; starting from 0")
		return
	}
	l.seq.Store(n)
}

func (l *Loop) persist(seq int64) {
	if l.Dir == "" {
		return
	}
	path := filepath.Join(l.Dir, StateFile)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(strconv.FormatInt(seq, 10)+"\n"), 0o600); err != nil {
		l.Log.Warn("could not persist the purge cursor", "err", err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		l.Log.Warn("could not persist the purge cursor", "err", err.Error())
	}
}

// Run polls until ctx ends. Call Load first to resume from the state file.
func (l *Loop) Run(ctx context.Context) {
	l.defaults()
	backoff := l.MinBackoff
	fail := func(msg string, args ...any) bool {
		wait := time.Duration(float64(backoff) * (0.8 + 0.4*rand.Float64()))
		if ctx.Err() == nil {
			l.Log.Warn(msg, append(args, "retryIn", wait.String())...)
		}
		backoff = min(backoff*2, l.MaxBackoff)
		return l.Sleep(ctx, wait)
	}
	for ctx.Err() == nil {
		key := l.Key()
		if key == nil {
			// Not registered yet: the key comes with registration.
			if !l.Sleep(ctx, l.MinBackoff) {
				return
			}
			continue
		}
		started := time.Now()
		changed, err := l.Poll(ctx, key)
		switch {
		case ctx.Err() != nil:
			return
		case errors.Is(err, errRefused):
			if !fail("purge batch refused", "err", err.Error()) {
				return
			}
			continue
		case err != nil:
			l.failures.Add(1)
			if !fail("purge poll failed", "err", err.Error()) {
				return
			}
			continue
		}
		backoff = l.MinBackoff
		if !changed {
			if rest := l.MinInterval - time.Since(started); rest > 0 && !l.Sleep(ctx, rest) {
				return
			}
		}
	}
}

// errRefused wraps a verification failure.
var errRefused = errors.New("refused")

// Poll fetches, verifies and applies one batch. It reports whether anything
// was applied or the cursor moved.
func (l *Loop) Poll(ctx context.Context, key ed25519.PublicKey) (bool, error) {
	l.defaults()
	after := l.seq.Load()
	signed, err := l.API.Purges(ctx, after)
	if err != nil {
		return false, err
	}
	b, err := tokens.VerifyPurgeBatch(key, signed)
	if err != nil {
		l.refused.Add(1)
		l.Log.Error("purge batch failed verification; ignoring it", "err", err.Error(), "after", after)
		return false, errors.Join(errRefused, err)
	}
	// Batches carry no freshness of their own, so an older genuine batch could
	// be replayed on path; it may never move the cursor back. A reset may (a
	// database reset), and it only empties the cache.
	if !b.Reset {
		if b.Seq < after {
			l.refused.Add(1)
			l.Log.Error("purge batch behind the cursor; ignoring it", "after", after, "seq", b.Seq)
			return false, fmt.Errorf("%w: batch seq %d behind cursor %d", errRefused, b.Seq, after)
		}
		for _, it := range b.Items {
			if it.Seq <= after || it.Seq > b.Seq {
				l.refused.Add(1)
				l.Log.Error("purge item outside the batch window; ignoring the batch", "after", after, "seq", b.Seq, "item", it.Seq)
				return false, fmt.Errorf("%w: item seq %d outside (%d, %d]", errRefused, it.Seq, after, b.Seq)
			}
		}
	}
	if b.Reset {
		l.Target.PurgeAll()
		l.resets.Add(1)
		l.Log.Warn("purge feed reset: evicted every cached live and DVR object", "after", after, "seq", b.Seq)
	}
	for _, it := range b.Items {
		l.Target.PurgePrefix(it.Prefix)
		l.applied.Add(1)
		if !KnownReasons[it.Reason] {
			l.unknown.Add(1)
		}
		l.Log.Info("purged", "prefix", it.Prefix, "reason", it.Reason, "seq", it.Seq)
	}
	moved := b.Seq != after
	if moved {
		l.seq.Store(b.Seq)
		l.persist(b.Seq)
	}
	return moved || b.Reset || len(b.Items) > 0, nil
}
