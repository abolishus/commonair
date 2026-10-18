// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { parseNetworkList } from "../src/network.ts";
import { noisyOr, stdev } from "../src/signals/combine.ts";
import { fetchChecks, fetchSignal } from "../src/signals/fetch.ts";
import { HEADLESS_WEIGHTS, headlessFlags, headlessSignal } from "../src/signals/headless.ts";
import { heartbeatChecks, heartbeatSignal } from "../src/signals/heartbeat.ts";
import { concurrencySignal, datacenterSignal } from "../src/signals/network.ts";
import type { HeartbeatSample } from "../src/types.ts";

const CHROME_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const HEADLESS = CHROME_DESKTOP.replace("Chrome/", "HeadlessChrome/");
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

/** Human-like beats: ~10 s apart with jitter, playing, visible, buffer moving. */
function humanBeats(n: number, start = 1_700_000_000_000): HeartbeatSample[] {
  let at = start;
  return Array.from({ length: n }, (_, i) => {
    at += 10_000 + ((i * 7919) % 400) - 200;
    return {
      at,
      playedSeconds: 9.5 + (i % 3) * 0.2,
      bufferSeconds: 3 + (i % 4) * 0.5,
      visible: true,
      muted: i % 2 === 0,
      stalls: 0,
      bytesHttp: 0,
      bytesP2p: 0,
    };
  });
}

describe("combine", () => {
  test("noisy-OR combines evidence and stays in [0, 1]", () => {
    expect(noisyOr([])).toBe(0);
    expect(noisyOr([0.5, 0.5])).toBe(0.75);
    expect(noisyOr([1, 0.2])).toBe(1);
    expect(noisyOr([2, -1, Number.NaN])).toBe(1);
    expect(noisyOr([0, 0, 0])).toBe(0);
  });
  test("stdev of fewer than two values is 0", () => {
    expect(stdev([5])).toBe(0);
    expect(stdev([1, 3])).toBeCloseTo(Math.SQRT2);
  });
});

describe("datacenter_ip", () => {
  const { classifier } = parseNetworkList("AS64500 Example Cloud");
  test("fires when the session was classified as hosting at start", () => {
    expect(datacenterSignal({ datacenter: "Example Hosting", asn: 64512 })).toEqual({
      code: "datacenter_ip",
      score: 0.8,
      details: { network: "Example Hosting", asn: 64512 },
    });
  });
  test("fires for an ASN on the operator list", () => {
    expect(datacenterSignal({ datacenter: null, asn: 64500 }, classifier)?.details).toEqual({
      network: "Example Cloud",
      asn: 64500,
    });
  });
  test("does not fire for residential networks or unknown ASNs", () => {
    expect(datacenterSignal({ datacenter: null, asn: null }, classifier)).toBeNull();
    expect(datacenterSignal({ datacenter: null, asn: 64501 }, classifier)).toBeNull();
    expect(datacenterSignal({ datacenter: "", asn: 64501 })).toBeNull();
  });
});

describe("device_concurrency / account_concurrency", () => {
  test("the oldest `max` sessions are fine; later ones fire", () => {
    expect(concurrencySignal("device_concurrency", { rank: 3, concurrent: 5 }, 3)).toBeNull();
    expect(concurrencySignal("device_concurrency", { rank: 4, concurrent: 5 }, 3)).toEqual({
      code: "device_concurrency",
      score: 0.9,
      details: { rank: 4, concurrent: 5, max: 3 },
    });
  });
  test("exactly the allowance never fires; anonymous accounts are skipped", () => {
    expect(concurrencySignal("account_concurrency", { rank: 3, concurrent: 3 }, 3)).toBeNull();
    expect(concurrencySignal("account_concurrency", null, 3)).toBeNull();
  });
});

describe("headless", () => {
  test("a normal desktop browser has no flags", () => {
    const fp = {
      webdriver: false,
      automation: false,
      plugins: 5,
      webgl: true,
      innerWidth: 1280,
      innerHeight: 720,
      audio: true,
    };
    expect(headlessFlags(fp, CHROME_DESKTOP)).toEqual([]);
    expect(headlessSignal(fp, CHROME_DESKTOP)).toBeNull();
  });

  test("each flag is detected", () => {
    expect(headlessFlags({ webdriver: true }, CHROME_DESKTOP)).toEqual(["webdriver"]);
    expect(headlessFlags({}, HEADLESS)).toEqual(["headless_user_agent"]);
    expect(headlessFlags({ automation: true }, null)).toEqual(["automation_globals"]);
    expect(headlessFlags({ innerWidth: 0, innerHeight: 0 }, null)).toEqual(["zero_window"]);
    expect(headlessFlags({ webgl: false }, null)).toEqual(["no_webgl"]);
    expect(headlessFlags({ plugins: 0 }, CHROME_DESKTOP)).toEqual(["no_plugins_desktop"]);
    expect(headlessFlags({ audio: false }, null)).toEqual(["no_audio_context"]);
    expect(headlessFlags({ userAgent: HEADLESS }, null)).toEqual(["headless_user_agent"]);
  });

  test("zero plugins on mobile is normal", () => {
    expect(headlessFlags({ plugins: 0 }, IPHONE)).toEqual([]);
  });

  test("no single flag reaches the default exclusion score; combinations do", () => {
    for (const w of Object.values(HEADLESS_WEIGHTS)) expect(w).toBeLessThan(0.7);
    expect(headlessSignal({ webdriver: true }, CHROME_DESKTOP)!.score).toBe(0.6);
    const s = headlessSignal({ webdriver: true, webgl: false, plugins: 0 }, HEADLESS)!;
    expect(s.score).toBeGreaterThan(0.9);
    expect(s.details.flags).toEqual(["webdriver", "headless_user_agent", "no_webgl", "no_plugins_desktop"]);
  });
});

describe("heartbeat_inconsistent", () => {
  test("a human-like stream has no findings", () => {
    expect(heartbeatSignal(humanBeats(20))).toBeNull();
  });

  test("too few beats yields nothing", () => {
    expect(heartbeatChecks(humanBeats(2)).checks).toEqual([]);
  });

  test("played seconds beyond 1.5× wall clock", () => {
    const beats = humanBeats(5).map((b) => ({ ...b, playedSeconds: 16 }));
    expect(heartbeatChecks(beats).checks).toContain("played_exceeds_wall_clock");
    const ok = humanBeats(5).map((b) => ({ ...b, playedSeconds: 14 }));
    expect(heartbeatChecks(ok).checks).not.toContain("played_exceeds_wall_clock");
  });

  test("never visible and always muted", () => {
    const beats = humanBeats(3).map((b) => ({ ...b, visible: false, muted: true }));
    expect(heartbeatChecks(beats).checks).toEqual(["never_visible_and_muted"]);
    // Visible once is enough to be a viewer.
    beats[1] = { ...beats[1]!, visible: true };
    expect(heartbeatChecks(beats).checks).toEqual([]);
  });

  test("buffer that never changes while playing (≥ 5 beats)", () => {
    const beats = humanBeats(5).map((b) => ({ ...b, bufferSeconds: 4 }));
    expect(heartbeatChecks(beats).checks).toContain("buffer_never_advances");
    expect(heartbeatChecks(beats.slice(0, 4)).checks).not.toContain("buffer_never_advances");
    // A paused player with a full buffer is not suspicious.
    const paused = beats.map((b) => ({ ...b, playedSeconds: 0 }));
    expect(heartbeatChecks(paused).checks).not.toContain("buffer_never_advances");
  });

  test("perfectly periodic timing (< 5 ms stdev over ≥ 10 beats)", () => {
    const periodic = humanBeats(10).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000 + (i % 2) * 3 }));
    expect(heartbeatChecks(periodic).checks).toContain("periodic_timing");
    expect(heartbeatChecks(periodic.slice(0, 9)).checks).not.toContain("periodic_timing");
    const jittery = humanBeats(10).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000 + (i % 2) * 12 }));
    expect(heartbeatChecks(jittery).checks).not.toContain("periodic_timing");
  });

  test("findings combine; the classic bot (periodic + frozen buffer) crosses 0.7", () => {
    const bot = humanBeats(12).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000, bufferSeconds: 2 }));
    const s = heartbeatSignal(bot)!;
    expect(s.details.checks).toEqual(["buffer_never_advances", "periodic_timing"]);
    expect(s.score).toBeCloseTo(0.76, 6);
  });

  test("beats are evaluated in time order regardless of input order", () => {
    const beats = humanBeats(12);
    expect(heartbeatChecks([...beats].reverse())).toEqual(heartbeatChecks(beats));
  });
});

describe("fetch_pattern", () => {
  const ctx = { segmentDurationSeconds: 1, partsPerSegment: 5 };
  const base = { assignedSource: "origin" as const, watchSeconds: 60, bytesHttp: 1000, bytesP2p: 0 };

  test("a normal session matches its watch time", () => {
    expect(fetchSignal(base, { playlists: 60, segments: 58, parts: 0 }, ctx)).toBeNull();
    // LL-HLS players fetch parts instead of segments.
    expect(fetchSignal(base, { playlists: 300, segments: 0, parts: 290 }, ctx)).toBeNull();
  });

  test("playlists without segments", () => {
    const r = fetchChecks(base, { playlists: 40, segments: 0, parts: 0 }, ctx);
    expect(r.checks).toEqual(["playlists_without_segments"]);
    expect(fetchChecks(base, { playlists: 9, segments: 0, parts: 0 }, { ...ctx }).checks).not.toContain(
      "playlists_without_segments",
    );
  });

  test("segments without playlists", () => {
    expect(fetchChecks(base, { playlists: 0, segments: 60, parts: 0 }, ctx).checks).toEqual([
      "segments_without_playlists",
    ]);
    // Unknown playlist count (database counter only) never fires this.
    expect(fetchChecks(base, { playlists: null, segments: 60, parts: null }, ctx).checks).toEqual([]);
  });

  test("too few or too many segments for the watch time", () => {
    expect(fetchChecks(base, { playlists: 60, segments: 10, parts: 0 }, ctx).checks).toEqual(["too_few_segments"]);
    expect(fetchChecks(base, { playlists: 60, segments: 300, parts: 0 }, ctx).checks).toEqual(["too_many_segments"]);
    // Short watch times are not judged.
    expect(fetchChecks({ ...base, watchSeconds: 5 }, { playlists: 5, segments: 0, parts: 0 }, ctx).checks).toEqual([]);
  });

  test("P2P delivery lowers the HTTP segments expected", () => {
    const p2p = { ...base, bytesHttp: 100, bytesP2p: 900 };
    expect(fetchChecks(p2p, { playlists: 60, segments: 6, parts: 0 }, ctx).checks).toEqual([]);
  });

  test("relay-assigned sessions are not judged by origin fetches", () => {
    expect(fetchSignal({ ...base, assignedSource: "relay" }, { playlists: 40, segments: 0, parts: 0 }, ctx)).toBeNull();
  });
});
