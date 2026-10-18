// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package relay

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// bigBytes is large enough that a viewer who stops reading leaves the relay
// blocked mid-write (loopback socket buffers are a few MB at most).
const bigBytes = 24 << 20

func TestGracefulStopFinishesInFlightTransfers(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)
	h.origin.mu.Lock()
	h.origin.slow = 300 * time.Millisecond
	h.origin.mu.Unlock()

	type result struct {
		status int
		n      int
		err    error
	}
	got := make(chan result, 1)
	go func() {
		status, body, _, err := h.fetch("/hls/live/alice/seg1.mp4?t=" + h.token(sid(3)))
		got <- result{status, len(body), err}
	}()
	h.eventually("origin fetch in flight", func() bool { return h.origin.hitCount("seg1.mp4") == 1 })

	if err := rel.GracefulStop(h.relaySrv.Config, 5*time.Second, 2*time.Second); err != nil {
		t.Fatalf("graceful stop: %v", err)
	}
	r := <-got
	if r.err != nil || r.status != http.StatusOK || r.n != media["seg1.mp4"] {
		t.Fatalf("in-flight transfer cut: %+v", r)
	}
	bytes, segments := h.api.receiptTotals(t)
	if bytes[sid(3)] != int64(media["seg1.mp4"]) || segments[sid(3)] != 1 {
		t.Fatalf("final receipt %d bytes/%d segments, want the completed transfer", bytes[sid(3)], segments[sid(3)])
	}
}

func TestGracefulStopAfterDrainCountsOnlyWrittenBytes(t *testing.T) {
	h := newHarness(t)
	rel := h.start(200)
	conn, err := net.Dial("tcp", strings.TrimPrefix(h.relaySrv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET /hls/live/alice/big.mp4?t=%s HTTP/1.1\r\nHost: relay\r\n\r\n", h.token(sid(4)))
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("response: %v %v", resp, err)
	}
	// Read a little, then stall like a viewer on a dead link.
	if _, err := io.ReadFull(resp.Body, make([]byte, 64<<10)); err != nil {
		t.Fatal(err)
	}
	h.eventually("relay blocked mid-write", func() bool { return rel.ledger.TotalBytes() > 64<<10 })
	time.Sleep(50 * time.Millisecond)

	start := time.Now()
	if err := rel.GracefulStop(h.relaySrv.Config, 200*time.Millisecond, 2*time.Second); err != nil {
		t.Fatalf("graceful stop: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("stop took %v", elapsed)
	}
	bytes, segments := h.api.receiptTotals(t)
	if bytes[sid(4)] <= 0 || bytes[sid(4)] >= bigBytes || segments[sid(4)] != 0 {
		t.Fatalf("truncated transfer reported as %d bytes/%d segments", bytes[sid(4)], segments[sid(4)])
	}
	// Everything the ledger ever counted is in a delivered receipt: no bytes
	// were added after the final period was cut.
	var total int64
	for _, b := range bytes {
		total += b
	}
	if total != rel.ledger.TotalBytes() {
		t.Fatalf("receipts report %d bytes, ledger counted %d", total, rel.ledger.TotalBytes())
	}
	if p := rel.ledger.Cut(time.Now()); len(p.Entries) != 0 {
		t.Fatalf("bytes counted after the final receipt: %+v", p.Entries)
	}
}

func TestOriginTransportIsBounded(t *testing.T) {
	tr := originTransport()
	if tr.MaxConnsPerHost != MaxOriginConns || tr.MaxConnsPerHost <= 0 {
		t.Fatalf("MaxConnsPerHost = %d", tr.MaxConnsPerHost)
	}
}
