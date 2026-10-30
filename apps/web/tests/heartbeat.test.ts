// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import {
  HeartbeatAccountant,
  MAX_PLAYED_PER_HEARTBEAT,
  nextHeartbeatDelay,
  playbackFields,
  withToken,
  type CumulativeStats,
} from "../src/player/heartbeat.ts";

const totals = (over: Partial<CumulativeStats> = {}): CumulativeStats => ({
  playedSeconds: 0,
  bufferSeconds: 2,
  stalls: 0,
  bytesHttp: 0,
  bytesP2p: 0,
  latencySeconds: 3.5,
  ttffMs: 900,
  visible: true,
  muted: true,
  ...over,
});

describe("HeartbeatAccountant", () => {
  it("reports deltas since the last committed heartbeat", () => {
    const acc = new HeartbeatAccountant();
    const first = totals({ playedSeconds: 10, stalls: 1, bytesHttp: 1000 });
    expect(acc.delta(first)).toMatchObject({ playedSeconds: 10, stalls: 1, bytesHttp: 1000, bytesP2p: 0 });
    acc.commit(first);
    const second = totals({ playedSeconds: 25, stalls: 3, bytesHttp: 4500.6 });
    expect(acc.delta(second)).toMatchObject({ playedSeconds: 15, stalls: 2, bytesHttp: 3501 });
  });

  it("rolls an unacknowledged heartbeat into the next one", () => {
    const acc = new HeartbeatAccountant();
    acc.commit(totals({ playedSeconds: 10, bytesHttp: 100 }));
    // This heartbeat fails: nothing is committed.
    expect(acc.delta(totals({ playedSeconds: 20, bytesHttp: 300 })).playedSeconds).toBe(10);
    const next = acc.delta(totals({ playedSeconds: 30, bytesHttp: 600 }));
    expect(next.playedSeconds).toBe(20);
    expect(next.bytesHttp).toBe(500);
  });

  it("clamps played time to the contract maximum", () => {
    const acc = new HeartbeatAccountant();
    expect(acc.delta(totals({ playedSeconds: 500 })).playedSeconds).toBe(MAX_PLAYED_PER_HEARTBEAT);
  });

  it("carries played time above the cap into later heartbeats instead of dropping it", () => {
    const acc = new HeartbeatAccountant();
    // E.g. heartbeats failed for a while: 300 s accumulated before one got through.
    const backlog = totals({ playedSeconds: 300 });
    expect(acc.delta(backlog).playedSeconds).toBe(120);
    acc.commit(backlog);
    expect(acc.delta(backlog).playedSeconds).toBe(120);
    acc.commit(backlog);
    const later = totals({ playedSeconds: 310 });
    expect(acc.delta(later).playedSeconds).toBe(70);
    acc.commit(later);
    expect(acc.delta(later).playedSeconds).toBe(0);
  });

  it("never reports negative or non-finite values", () => {
    const acc = new HeartbeatAccountant();
    acc.commit(totals({ playedSeconds: 50, stalls: 4, bytesHttp: 900 }));
    const d = acc.delta(
      totals({
        playedSeconds: 40,
        stalls: 2,
        bytesHttp: 100,
        bufferSeconds: -1,
        latencySeconds: Number.NaN,
        ttffMs: -5,
      }),
    );
    expect(d).toMatchObject({
      playedSeconds: 0,
      stalls: 0,
      bytesHttp: 0,
      bufferSeconds: 0,
      latencySeconds: null,
      ttffMs: 0,
    });
    expect(acc.delta(totals({ playedSeconds: Number.NaN })).playedSeconds).toBe(0);
  });

  it("passes visibility, mute, latency and first-frame time through", () => {
    const d = new HeartbeatAccountant().delta(
      totals({ visible: false, muted: false, latencySeconds: 4.25, ttffMs: 1234.4 }),
    );
    expect(d).toMatchObject({ visible: false, muted: false, latencySeconds: 4.25, ttffMs: 1234 });
    expect(new HeartbeatAccountant().delta(totals({ latencySeconds: null, ttffMs: null }))).toMatchObject({
      latencySeconds: null,
      ttffMs: null,
    });
  });

  describe("settle (throttled hint)", () => {
    it("commits an accepted beat", () => {
      const acc = new HeartbeatAccountant();
      const t1 = totals({ playedSeconds: 10, stalls: 1, bytesHttp: 1000, bytesP2p: 50 });
      expect(acc.settle(t1, { throttled: false })).toBe(true);
      expect(acc.delta(t1)).toMatchObject({ playedSeconds: 0, stalls: 0, bytesHttp: 0, bytesP2p: 0 });
      expect(acc.settle(t1, {})).toBe(true);
    });

    it("carries a throttled beat's deltas into the next beat", () => {
      const acc = new HeartbeatAccountant();
      acc.commit(totals({ playedSeconds: 10, stalls: 1, bytesHttp: 1000, bytesP2p: 10 }));
      const throttledAt = totals({ playedSeconds: 12, stalls: 2, bytesHttp: 1400, bytesP2p: 30 });
      expect(acc.delta(throttledAt)).toMatchObject({ playedSeconds: 2, stalls: 1, bytesHttp: 400, bytesP2p: 20 });
      expect(acc.settle(throttledAt, { throttled: true })).toBe(false);
      // The server recorded nothing: the next beat reports everything since the last accepted one.
      const next = totals({ playedSeconds: 30, stalls: 3, bytesHttp: 5000, bytesP2p: 40 });
      expect(acc.delta(next)).toMatchObject({ playedSeconds: 20, stalls: 2, bytesHttp: 4000, bytesP2p: 30 });
      expect(acc.settle(next, {})).toBe(true);
      expect(acc.delta(next)).toMatchObject({ playedSeconds: 0, stalls: 0, bytesHttp: 0, bytesP2p: 0 });
    });

    it("keeps carrying across several throttled beats", () => {
      const acc = new HeartbeatAccountant();
      for (const played of [1, 2, 3])
        expect(acc.settle(totals({ playedSeconds: played }), { throttled: true })).toBe(false);
      expect(acc.delta(totals({ playedSeconds: 4 })).playedSeconds).toBe(4);
    });

    it("still caps a carried backlog at the per-beat maximum", () => {
      const acc = new HeartbeatAccountant();
      acc.settle(totals({ playedSeconds: 100 }), { throttled: true });
      const big = totals({ playedSeconds: 200 });
      expect(acc.delta(big).playedSeconds).toBe(MAX_PLAYED_PER_HEARTBEAT);
      acc.settle(big, {});
      expect(acc.delta(big).playedSeconds).toBe(80);
    });
  });
});

describe("HeartbeatAccountant: P2P fields", () => {
  const p2p = (over: Partial<CumulativeStats> = {}) => totals({ bytesP2pUp: 0, p2pPeers: 0, p2pRejected: 0, ...over });

  it("sends bytesP2p, bytesP2pUp and p2pRejected as deltas and p2pPeers as a gauge", () => {
    const acc = new HeartbeatAccountant();
    const first = p2p({ bytesHttp: 500, bytesP2p: 4000, bytesP2pUp: 1000, p2pPeers: 3, p2pRejected: 1 });
    expect(acc.delta(first)).toMatchObject({
      bytesHttp: 500,
      bytesP2p: 4000,
      bytesP2pUp: 1000,
      p2pPeers: 3,
      p2pRejected: 1,
    });
    acc.commit(first);
    const second = p2p({ bytesHttp: 700, bytesP2p: 9000, bytesP2pUp: 1500, p2pPeers: 3, p2pRejected: 1 });
    // The gauge is reported as is every time; the counters only grow by what is new.
    expect(acc.delta(second)).toMatchObject({
      bytesHttp: 200,
      bytesP2p: 5000,
      bytesP2pUp: 500,
      p2pPeers: 3,
      p2pRejected: 0,
    });
  });

  it("carries throttled and failed beats' P2P deltas into the next beat", () => {
    const acc = new HeartbeatAccountant();
    acc.commit(p2p({ bytesP2p: 100, bytesP2pUp: 10, p2pRejected: 1 }));
    const throttled = p2p({ bytesP2p: 300, bytesP2pUp: 40, p2pRejected: 2, p2pPeers: 2 });
    expect(acc.settle(throttled, { throttled: true })).toBe(false);
    const next = p2p({ bytesP2p: 600, bytesP2pUp: 90, p2pRejected: 4, p2pPeers: 1 });
    expect(acc.delta(next)).toMatchObject({ bytesP2p: 500, bytesP2pUp: 80, p2pRejected: 3, p2pPeers: 1 });
    expect(acc.settle(next, {})).toBe(true);
    expect(acc.delta(next)).toMatchObject({ bytesP2p: 0, bytesP2pUp: 0, p2pRejected: 0, p2pPeers: 1 });
  });

  it("caps the peer gauge at the contract's 64 and never sends negatives", () => {
    const acc = new HeartbeatAccountant();
    expect(acc.delta(p2p({ p2pPeers: 500 })).p2pPeers).toBe(64);
    expect(acc.delta(p2p({ p2pPeers: -2, bytesP2pUp: Number.NaN })).p2pPeers).toBe(0);
    acc.commit(p2p({ bytesP2pUp: 50, p2pRejected: 5 }));
    expect(acc.delta(p2p({ bytesP2pUp: 10, p2pRejected: 2 }))).toMatchObject({ bytesP2pUp: 0, p2pRejected: 0 });
  });

  it("sessions without the P2P loader send none of the P2P diagnostics", () => {
    const d = new HeartbeatAccountant().delta(totals({ bytesHttp: 10 }));
    for (const k of ["bytesP2pUp", "p2pPeers", "p2pRejected"]) expect(d).not.toHaveProperty(k);
    expect(d.bytesP2p).toBe(0);
  });

  it("bytesHttp carries HTTP bytes only: a peer-delivered segment moves bytesP2p, not bytesHttp", () => {
    const acc = new HeartbeatAccountant();
    acc.commit(p2p({ bytesHttp: 1000 }));
    // The controller adds peer bytes to bytesP2p only (tests/p2p-engine.test.ts checks the wiring).
    expect(acc.delta(p2p({ bytesHttp: 1000, bytesP2p: 8000 }))).toMatchObject({ bytesHttp: 0, bytesP2p: 8000 });
  });
});

describe("nextHeartbeatDelay", () => {
  it("stays within the jitter band", () => {
    expect(nextHeartbeatDelay(10_000, 0.1, () => 0)).toBe(9_000);
    expect(nextHeartbeatDelay(10_000, 0.1, () => 1)).toBe(11_000);
    expect(nextHeartbeatDelay(10_000, 0.1, () => 0.5)).toBe(10_000);
  });
  it("never goes below one second", () => {
    expect(nextHeartbeatDelay(100, 0.1, () => 0)).toBe(1_000);
  });
});

describe("withToken", () => {
  it("replaces an existing token parameter", () => {
    expect(withToken("http://o/hls/x.m3u8?t=old&_HLS_msn=4", "new")).toBe("http://o/hls/x.m3u8?t=new&_HLS_msn=4");
  });
  it("leaves URLs without a token alone", () => {
    expect(withToken("http://o/seg/1.mp4", "new")).toBe("http://o/seg/1.mp4");
  });
});

describe("playbackFields", () => {
  it("live: playbackMode live and behindLiveSeconds null (W1 sends this on every beat)", () => {
    expect(playbackFields("live")).toEqual({ playbackMode: "live", behindLiveSeconds: null });
    expect(playbackFields("live", 30)).toEqual({ playbackMode: "live", behindLiveSeconds: null });
  });

  it("dvr: how far behind, within the contract's 0..86400, null when unknown", () => {
    expect(playbackFields("dvr")).toEqual({ playbackMode: "dvr", behindLiveSeconds: null });
    expect(playbackFields("dvr", 42.5)).toEqual({ playbackMode: "dvr", behindLiveSeconds: 42.5 });
    expect(playbackFields("dvr", -3).behindLiveSeconds).toBe(0);
    expect(playbackFields("dvr", 1e9).behindLiveSeconds).toBe(86_400);
    expect(playbackFields("dvr", Number.NaN).behindLiveSeconds).toBeNull();
  });
});
