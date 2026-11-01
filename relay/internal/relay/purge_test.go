// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package relay

import (
	"context"
	"crypto/ed25519"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/abolishus/commonair/relay/internal/purge"
	"github.com/abolishus/commonair/relay/internal/tokens"
)

// End to end (batch 7 decision (x)): the relay long-polls the purge feed
// beside its heartbeat, verifies each batch with the origin key from
// registration, evicts the prefix (the next viewer request goes back to the
// origin), refuses a batch signed by anyone else, reports its cursor on
// /healthz and keeps it in the state directory.
func TestRelayFollowsTheSignedPurgeFeed(t *testing.T) {
	h := newHarness(t)
	_, impostor, _ := ed25519.GenerateKey(nil)
	forged, err := tokens.SignPurgeBatch(impostor, tokens.PurgeBatch{Seq: 99, Items: []tokens.PurgeItem{{Seq: 99, Prefix: "live/alice/", Reason: "suspended"}}})
	if err != nil {
		t.Fatal(err)
	}
	h.api.set(func(a *fakeAPI) { a.purgeKey = h.originKey })
	rel := h.start(1000)
	defer func() { _ = rel.Shutdown(context.Background()) }()

	tok := h.token("01890000-0000-7000-8000-000000000001")
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+tok); status != http.StatusOK {
		t.Fatalf("seg1 %d", status)
	}
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+tok); status != http.StatusOK || h.origin.hitCount("seg1.mp4") != 1 {
		t.Fatalf("seg1 not cached: %d hits", h.origin.hitCount("seg1.mp4"))
	}

	// A forged batch is refused whole: nothing evicted, the cursor stays.
	h.api.set(func(a *fakeAPI) { a.purges = append(a.purges, forged) })
	h.eventually("the forged batch consumed", func() bool {
		var n int
		h.api.set(func(a *fakeAPI) { n = len(a.purges) })
		return n == 0
	})
	h.eventually("another poll after the forged batch", func() bool {
		var afters []string
		h.api.set(func(a *fakeAPI) { afters = append([]string(nil), a.purgeAfters...) })
		return len(afters) >= 2
	})
	if seq := h.health().PurgeSeq; seq == nil || *seq != 0 {
		t.Fatalf("cursor moved on a forged batch: %v", seq)
	}
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+tok); status != http.StatusOK || h.origin.hitCount("seg1.mp4") != 1 {
		t.Fatal("a forged batch evicted the cache")
	}

	genuine, err := tokens.SignPurgeBatch(h.originKey, tokens.PurgeBatch{Seq: 7, Items: []tokens.PurgeItem{{Seq: 7, Prefix: "live/alice/", Reason: "suspended"}}})
	if err != nil {
		t.Fatal(err)
	}
	h.api.set(func(a *fakeAPI) { a.purges = append(a.purges, genuine) })
	h.eventually("the cursor reaches 7", func() bool {
		seq := h.health().PurgeSeq
		return seq != nil && *seq == 7
	})
	h.eventually("the next poll asks after 7", func() bool {
		var last string
		h.api.set(func(a *fakeAPI) {
			if n := len(a.purgeAfters); n > 0 {
				last = a.purgeAfters[n-1]
			}
		})
		return last == "7"
	})
	if status, _, _ := h.get(t, "/hls/live/alice/seg1.mp4?t="+tok); status != http.StatusOK || h.origin.hitCount("seg1.mp4") != 2 {
		t.Fatalf("seg1 was not evicted: %d origin hits", h.origin.hitCount("seg1.mp4"))
	}
	data, err := os.ReadFile(filepath.Join(h.dataDir, purge.StateFile))
	if err != nil || strings.TrimSpace(string(data)) != "7" {
		t.Fatalf("persisted cursor %q (%v)", data, err)
	}
}

// A restarted relay resumes from its state directory.
func TestRelayResumesThePurgeCursor(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(filepath.Join(h.dataDir, purge.StateFile), []byte("41\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.api.set(func(a *fakeAPI) { a.purgeKey = h.originKey })
	rel := h.start(1000)
	defer func() { _ = rel.Shutdown(context.Background()) }()
	h.eventually("a poll after 41", func() bool {
		var afters []string
		h.api.set(func(a *fakeAPI) { afters = append([]string(nil), a.purgeAfters...) })
		return len(afters) > 0 && afters[0] == "41"
	})
	if seq := h.health().PurgeSeq; seq == nil || *seq != 41 {
		t.Fatalf("health purgeSeq %v", seq)
	}
}
