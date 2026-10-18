// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/abolishus/commonair/relay/internal/cache"
)

var (
	errNotFound = errors.New("not found at origin")
	errTooLarge = errors.New("origin object too large")
)

// upstreamError is any other origin failure.
type upstreamError struct{ status int }

func (e upstreamError) Error() string { return fmt.Sprintf("origin HTTP %d", e.status) }

// Size limits for origin responses held in memory.
const (
	maxPlaylistBytes = 4 << 20
	maxMediaBytes    = 64 << 20
)

// fetchOrigin GETs <pull base><rel> with the relay bearer token and reads the
// whole body (bounded). The caller supplies a context detached from any one
// viewer so coalesced waiters are not cut off by the first one leaving.
func (s *Server) fetchOrigin(ctx context.Context, pull *url.URL, rel string, limit int64) (cache.Entry, error) {
	u, err := pull.Parse(rel)
	if err != nil {
		return cache.Entry{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return cache.Entry{}, err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.PullToken)
	req.Header.Set("User-Agent", "commonair-relay/"+s.cfg.Version)
	resp, err := s.cfg.Origin.Do(req)
	if err != nil {
		return cache.Entry{}, err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return cache.Entry{}, errNotFound
	case resp.StatusCode != http.StatusOK:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return cache.Entry{}, upstreamError{status: resp.StatusCode}
	}
	if resp.ContentLength > limit {
		return cache.Entry{}, errTooLarge
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return cache.Entry{}, err
	}
	if int64(len(body)) > limit {
		return cache.Entry{}, errTooLarge
	}
	return cache.Entry{Body: body, ContentType: resp.Header.Get("Content-Type")}, nil
}
