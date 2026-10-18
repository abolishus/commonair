// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import {
  HeartbeatAccountant,
  MAX_PLAYED_PER_HEARTBEAT,
  nextHeartbeatDelay,
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
