// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package apiclient speaks the relay protocol (relays.register, .heartbeat,
// .receipt in packages/contracts/src/api/router.ts) served under /api.
package apiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/abolishus/commonair/relay/internal/tokens"
)

// Client calls the instance API with the relay registration token.
type Client struct {
	base  *url.URL
	token string
	http  *http.Client
	agent string
}

// New returns a client for the API at apiURL (for example https://instance/).
func New(apiURL, token, version string, httpClient *http.Client) (*Client, error) {
	u, err := url.Parse(apiURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("--api must be an http(s) URL")
	}
	if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	u.RawQuery, u.Fragment = "", ""
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &Client{base: u, token: token, http: httpClient, agent: "commonair-relay/" + version}, nil
}

// RegisterRequest is the relays.register input.
type RegisterRequest struct {
	PublicURL            string `json:"publicUrl"`
	DeclaredCapacityMbps int    `json:"declaredCapacityMbps"`
	PublicKey            string `json:"publicKey"`
	Version              string `json:"version"`
	Region               string `json:"region"`
}

// RegisterResponse is the relays.register output.
type RegisterResponse struct {
	RelayID                  string `json:"relayId"`
	OriginURL                string `json:"originUrl"`
	OriginPublicKey          string `json:"originPublicKey"`
	ReceiptIntervalSeconds   int    `json:"receiptIntervalSeconds"`
	HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
	Status                   string `json:"status"`
}

// HeartbeatRequest is the relays.heartbeat input.
type HeartbeatRequest struct {
	ActiveViewers int     `json:"activeViewers"`
	EgressMbps    float64 `json:"egressMbps"`
	CacheBytes    int64   `json:"cacheBytes"`
	// Draining takes the relay out of assignment at once (status offline).
	Draining bool `json:"draining"`
}

// HeartbeatResponse is the relays.heartbeat output.
type HeartbeatResponse struct {
	Status          string `json:"status"`
	OriginPublicKey string `json:"originPublicKey"`
}

// ReceiptResponse is the relays.receipt output.
type ReceiptResponse struct {
	ReceiptID string `json:"receiptId"`
	Status    string `json:"status"`
}

// Error is a non-2xx API response. Code is the oRPC error code when present.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("api: HTTP %d %s %s", e.Status, e.Code, e.Message)
}

// Unknown reports whether the API no longer recognizes this relay, so it
// should register again.
func (e *Error) Unknown() bool {
	return e.Status == http.StatusUnauthorized || e.Status == http.StatusNotFound
}

// Permanent reports whether retrying the same request cannot succeed.
func (e *Error) Permanent() bool {
	switch e.Status {
	case http.StatusBadRequest, http.StatusConflict, http.StatusUnprocessableEntity, http.StatusRequestEntityTooLarge:
		return true
	}
	return false
}

// AsError unwraps an *Error.
func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

// Register announces the relay.
func (c *Client) Register(ctx context.Context, r RegisterRequest) (RegisterResponse, error) {
	if len(r.Version) > 40 {
		r.Version = r.Version[:40]
	}
	var out RegisterResponse
	if err := c.post(ctx, "api/relay/register", r, &out); err != nil {
		return out, err
	}
	if !tokens.IsUUID(out.RelayID) || out.OriginURL == "" || out.OriginPublicKey == "" {
		return out, errors.New("api: incomplete register response")
	}
	return out, nil
}

// Heartbeat reports liveness and load.
func (c *Client) Heartbeat(ctx context.Context, r HeartbeatRequest) (HeartbeatResponse, error) {
	var out HeartbeatResponse
	err := c.post(ctx, "api/relay/heartbeat", r, &out)
	return out, err
}

// SubmitReceipt posts a signed receipt.
func (c *Client) SubmitReceipt(ctx context.Context, r tokens.SignedReceipt) (ReceiptResponse, error) {
	var out ReceiptResponse
	err := c.post(ctx, "api/relay/receipts", r, &out)
	return out, err
}

const maxResponse = 1 << 20

func (c *Client) post(ctx context.Context, path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	u := c.base.ResolveReference(&url.URL{Path: path})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.agent)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		apiErr := &Error{Status: resp.StatusCode}
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &e) == nil {
			apiErr.Code, apiErr.Message = e.Code, truncate(e.Message, 200)
		}
		return apiErr
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("api: decode %s response: %w", path, err)
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
