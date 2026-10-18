// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package receipts

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/abolishus/commonair/relay/internal/apiclient"
	"github.com/abolishus/commonair/relay/internal/tokens"
)

// Submitter posts one signed receipt.
type Submitter interface {
	SubmitReceipt(ctx context.Context, r tokens.SignedReceipt) (apiclient.ReceiptResponse, error)
}

// Sender delivers queued receipts in order, retrying transient failures with
// capped exponential backoff.
type Sender struct {
	Queue      *Queue
	API        Submitter
	Log        *slog.Logger
	MinBackoff time.Duration
	MaxBackoff time.Duration
	// Timeout bounds one submission.
	Timeout time.Duration

	sendMu sync.Mutex
	kick   chan struct{}
	once   sync.Once
}

func (s *Sender) init() {
	s.once.Do(func() {
		s.kick = make(chan struct{}, 1)
		if s.MinBackoff <= 0 {
			s.MinBackoff = time.Second
		}
		if s.MaxBackoff <= 0 {
			s.MaxBackoff = 5 * time.Minute
		}
		if s.Timeout <= 0 {
			s.Timeout = 15 * time.Second
		}
		if s.Log == nil {
			s.Log = slog.Default()
		}
	})
}

// Kick wakes the sender after a receipt was queued.
func (s *Sender) Kick() {
	s.init()
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// Run delivers receipts until ctx ends.
func (s *Sender) Run(ctx context.Context) {
	s.init()
	backoff := time.Duration(0)
	for {
		if err := s.SendAll(ctx); err != nil {
			if backoff == 0 {
				backoff = s.MinBackoff
			} else {
				backoff = min(backoff*2, s.MaxBackoff)
			}
			wait := jitter(backoff)
			s.Log.Warn("receipt delivery failed; will retry", "err", err.Error(), "pending", s.Queue.Len(), "retryIn", wait.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			continue
		}
		backoff = 0
		select {
		case <-ctx.Done():
			return
		case <-s.kick:
		}
	}
}

// SendAll submits every queued receipt in order, stopping at the first
// transient failure so ordering is preserved and the API is not hammered.
func (s *Sender) SendAll(ctx context.Context) error {
	s.init()
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	for _, it := range s.Queue.Items() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		sctx, cancel := context.WithTimeout(ctx, s.Timeout)
		resp, err := s.API.SubmitReceipt(sctx, it.Receipt)
		cancel()
		if err != nil {
			if apiErr, ok := apiclient.AsError(err); ok && apiErr.Permanent() {
				// Malformed or a replayed nonce: resending cannot help.
				s.Log.Error("receipt rejected permanently; discarding", "receipt", it.Name, "status", apiErr.Status, "code", apiErr.Code)
				if rmErr := s.Queue.Remove(it.Name); rmErr != nil {
					s.Log.Warn("could not delete receipt file", "receipt", it.Name, "err", rmErr.Error())
				}
				continue
			}
			return err
		}
		s.Log.Info("receipt accepted", "receipt", it.Name, "receiptId", resp.ReceiptID, "status", resp.Status)
		if err := s.Queue.Remove(it.Name); err != nil {
			s.Log.Warn("could not delete receipt file", "receipt", it.Name, "err", err.Error())
		}
	}
	return nil
}

func jitter(d time.Duration) time.Duration {
	// ±20% so a fleet of relays recovering from an API outage spreads out.
	return time.Duration(float64(d) * (0.8 + 0.4*rand.Float64()))
}
