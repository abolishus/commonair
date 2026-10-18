// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { parseNetworkList } from "../src/network.ts";
import { noisyOr, stdev } from "../src/signals/combine.ts";
import { claimedSecondsUntil, fetchChecks, fetchSignal, httpShare } from "../src/signals/fetch.ts";
import { HEADLESS_WEIGHTS, headlessFlags, headlessSignal } from "../src/signals/headless.ts";
import { HEARTBEAT_WEIGHTS, heartbeatChecks, heartbeatSignal, visibleIntervals } from "../src/signals/heartbeat.ts";
import { concurrencySignal, DATACENTER_SCORE, datacenterSignal, PRIVACY_RELAY_SCORE } from "../src/signals/network.ts";
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
  const { classifier } = parseNetworkList("AS64500 Example Cloud\nAS64502 class=privacy_relay Example Relay");
  test("fires when the session was classified as hosting at start", () => {
    expect(datacenterSignal({ datacenter: "Example Hosting", asn: 64512 })).toEqual({
      code: "datacenter_ip",
      score: 0.6,
      details: { network: "Example Hosting", asn: 64512 },
    });
  });
  test("is below the default exclusion score: never fatal alone", () => {
    expect(DATACENTER_SCORE).toBeLessThan(0.7);
    expect(PRIVACY_RELAY_SCORE).toBeLessThan(DATACENTER_SCORE);
  });
  test("privacy relays (stored with the prefix, or by ASN class) are their own weak signal", () => {
    expect(datacenterSignal({ datacenter: "privacy_relay:Example Relay", asn: null })).toEqual({
      code: "privacy_relay",
      score: 0.3,
      details: { network: "Example Relay", asn: null },
    });
    expect(datacenterSignal({ datacenter: "privacy_relay:", asn: 1 })?.details).toEqual({ network: null, asn: 1 });
    expect(datacenterSignal({ datacenter: null, asn: 64502 }, classifier)).toMatchObject({
      code: "privacy_relay",
      details: { network: "Example Relay" },
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

  test("a background tab is weak corroboration only: with any single weak flag it stays at the threshold", () => {
    expect(HEARTBEAT_WEIGHTS.never_visible_and_muted).toBe(0.25);
    expect(noisyOr([HEARTBEAT_WEIGHTS.never_visible_and_muted, 0.6])).toBeLessThanOrEqual(0.7);
    // Hidden but audible (a music stream in the background) fires nothing.
    expect(heartbeatChecks(humanBeats(20).map((b) => ({ ...b, visible: false, muted: false }))).checks).toEqual([]);
  });

  test("buffer that never changes while playing (≥ 5 beats)", () => {
    const beats = humanBeats(5).map((b) => ({ ...b, bufferSeconds: 4 }));
    expect(heartbeatChecks(beats).checks).toContain("buffer_never_advances");
    expect(heartbeatChecks(beats.slice(0, 4)).checks).not.toContain("buffer_never_advances");
    // A paused player with a full buffer is not suspicious.
    const paused = beats.map((b) => ({ ...b, playedSeconds: 0 }));
    expect(heartbeatChecks(paused).checks).not.toContain("buffer_never_advances");
  });

  test("perfectly periodic timing (< 2 ms stdev over ≥ 10 visible intervals)", () => {
    const periodic = humanBeats(11).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000 + (i % 2) * 1 }));
    expect(heartbeatChecks(periodic).checks).toContain("periodic_timing");
    expect(heartbeatChecks(periodic.slice(0, 10)).checks).not.toContain("periodic_timing");
    // Ordinary event-loop and network jitter of a few ms is human.
    const jittery = humanBeats(11).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000 + (i % 2) * 5 }));
    expect(heartbeatChecks(jittery).checks).not.toContain("periodic_timing");
    expect(heartbeatChecks(jittery).measures.intervalStdevMs).toBeGreaterThan(2);
  });

  test("clamped / throttled timers in hidden tabs never count as periodic", () => {
    // Whole-second aligned, zero-jitter beats while hidden (Chrome timer alignment).
    const clamped = humanBeats(30).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000, visible: false }));
    expect(heartbeatChecks(clamped).checks).not.toContain("periodic_timing");
    expect(heartbeatChecks(clamped).measures.intervalStdevMs).toBeUndefined();
    // Intensive throttling: one beat a minute while hidden, then back to normal.
    const throttled = humanBeats(30).map((b, i) => ({
      ...b,
      at: 1_000_000 + i * 60_000,
      visible: i >= 25,
    }));
    expect(heartbeatChecks(throttled).checks).not.toContain("periodic_timing");
    // Alternating visibility leaves no visible-to-visible interval.
    const flicker = humanBeats(30).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000, visible: i % 2 === 0 }));
    expect(visibleIntervals(flicker)).toEqual([]);
    expect(heartbeatChecks(flicker).checks).not.toContain("periodic_timing");
  });

  test("periodic beats while visible still fire even when hidden beats are interleaved", () => {
    const beats = humanBeats(16).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000, visible: i !== 7 }));
    // 15 intervals, 2 touch the hidden beat: 13 visible ones remain.
    expect(visibleIntervals(beats)).toHaveLength(13);
    expect(heartbeatChecks(beats).checks).toContain("periodic_timing");
  });

  test("empty and single-beat histories yield nothing", () => {
    expect(heartbeatChecks([])).toEqual({ checks: [], measures: { beats: 0 } });
    expect(heartbeatChecks(humanBeats(1)).checks).toEqual([]);
    expect(visibleIntervals([])).toEqual([]);
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

  test("a p2p-assigned session is expected to fetch only a minimum HTTP share", () => {
    const p2p = { ...base, assignedSource: "p2p" as const };
    expect(fetchChecks(p2p, { playlists: 60, segments: 6, parts: 0 }, ctx).checks).toEqual([]);
    // The same fetches from an origin-assigned session are far too few.
    expect(fetchChecks(base, { playlists: 60, segments: 6, parts: 0 }, ctx).checks).toEqual(["too_few_segments"]);
  });

  test("relay-assigned sessions are not judged by origin fetches, and are held without receipts", () => {
    expect(fetchSignal({ ...base, assignedSource: "relay" }, { playlists: 40, segments: 0, parts: 0 }, ctx)).toBeNull();
    expect(
      fetchChecks({ ...base, assignedSource: "relay" }, { playlists: 40, segments: 0, parts: 0 }, ctx),
    ).toMatchObject({ skipped: "no_accounting", mediaUnconfirmed: true });
    expect(fetchChecks({ ...base, assignedSource: "relay" }, null, ctx).mediaUnconfirmed).toBe(true);
    expect(
      fetchChecks({ ...base, assignedSource: "relay" }, { relayObjects: null, claimedSeconds: 60 }, ctx)
        .mediaUnconfirmed,
    ).toBe(true);
  });

  test("no media at all while claiming playback (known counters)", () => {
    const r = fetchChecks(base, { playlists: 0, segments: 0, parts: 0 }, ctx);
    expect(r).toMatchObject({ checks: ["no_media_fetched"], mediaUnconfirmed: true, skipped: null });
    expect(fetchSignal(base, { playlists: 0, segments: 0, parts: 0 }, ctx)!.score).toBe(0.9);
    // Boundary: exactly 10 expected segments is judged, 9.x is not.
    expect(fetchChecks({ ...base, watchSeconds: 10 }, { playlists: 0, segments: 0, parts: 0 }, ctx).checks).toEqual([
      "no_media_fetched",
    ]);
    expect(fetchChecks({ ...base, watchSeconds: 9 }, { playlists: 0, segments: 0, parts: 0 }, ctx)).toMatchObject({
      checks: [],
      mediaUnconfirmed: false,
    });
    // A playlist poller is reported as such, not twice.
    expect(fetchChecks(base, { playlists: 40, segments: 0, parts: 0 }, ctx)).toMatchObject({
      checks: ["playlists_without_segments"],
      mediaUnconfirmed: true,
    });
  });

  test("database counter only (parts unknown): a tolerant ratio holds, never scores", () => {
    const zero = fetchChecks(base, { playlists: null, segments: 0, parts: null }, ctx);
    expect(zero).toMatchObject({ checks: [], mediaUnconfirmed: true });
    // 60 expected full segments × 10 % = 6.
    expect(fetchChecks(base, { playlists: null, segments: 5, parts: null }, ctx)).toMatchObject({
      checks: [],
      mediaUnconfirmed: true,
    });
    const enough = fetchChecks(base, { playlists: null, segments: 6, parts: null }, ctx);
    expect(enough).toMatchObject({ checks: [], mediaUnconfirmed: false });
    expect(enough.measures.segmentRatio).toBeCloseTo(0.1, 6);
    // At the 10-segment boundary at least one full segment is required.
    const short = { ...base, watchSeconds: 10 };
    expect(fetchChecks(short, { playlists: null, segments: 0, parts: null }, ctx).mediaUnconfirmed).toBe(true);
    expect(fetchChecks(short, { playlists: null, segments: 1, parts: null }, ctx).mediaUnconfirmed).toBe(false);
    // One segment then hours of heartbeats.
    const hours = { ...base, watchSeconds: 4 * 3600 };
    expect(fetchChecks(hours, { playlists: null, segments: 1, parts: null }, ctx).mediaUnconfirmed).toBe(true);
    expect(fetchChecks(hours, { playlists: null, segments: 1440, parts: null }, ctx).mediaUnconfirmed).toBe(false);
  });

  test("too few segments holds the session pending; too many does not", () => {
    expect(fetchChecks(base, { playlists: 60, segments: 14, parts: 0 }, ctx).mediaUnconfirmed).toBe(true);
    expect(fetchChecks(base, { playlists: 60, segments: 15, parts: 0 }, ctx)).toMatchObject({
      checks: [],
      mediaUnconfirmed: false,
    });
    expect(fetchChecks(base, { playlists: 60, segments: 300, parts: 0 }, ctx).mediaUnconfirmed).toBe(false);
  });

  test("CDN delivery is never judged; missing accounting is not judged", () => {
    const cdn = { ...base, assignedSource: "cdn" as const };
    expect(fetchChecks(cdn, { playlists: 0, segments: 0, parts: 0 }, ctx)).toEqual({
      checks: [],
      measures: {},
      mediaUnconfirmed: false,
      skipped: "cdn",
    });
    expect(fetchChecks(base, null, ctx)).toMatchObject({ skipped: "no_accounting", mediaUnconfirmed: false });
  });

  test("relay receipts: no objects excludes, too few holds, many is fine", () => {
    const relay = { ...base, assignedSource: "relay" as const };
    expect(fetchChecks(relay, { relayObjects: 0, claimedSeconds: 60 }, ctx).checks).toEqual(["no_media_fetched"]);
    expect(fetchChecks(relay, { relayObjects: 14, claimedSeconds: 60 }, ctx)).toMatchObject({
      checks: ["too_few_segments"],
      mediaUnconfirmed: true,
    });
    expect(fetchChecks(relay, { relayObjects: 15, claimedSeconds: 60 }, ctx).checks).toEqual([]);
    expect(fetchChecks(relay, { relayObjects: 1000, claimedSeconds: 60 }, ctx).checks).toEqual([]);
    // Too little claimed inside the receipts' window to judge.
    expect(fetchChecks(relay, { relayObjects: 0, claimedSeconds: 9 }, ctx)).toMatchObject({
      checks: [],
      mediaUnconfirmed: false,
    });
  });

  test("client-reported bytes never lower what is expected", () => {
    expect(httpShare({ assignedSource: "origin" })).toBe(1);
    expect(httpShare({ assignedSource: "p2p" })).toBe(0.1);
    // An origin session claiming all its bytes came over P2P is still expected to fetch over HTTP.
    const claimsP2p = { ...base, bytesHttp: 0, bytesP2p: 10_000 };
    expect(fetchChecks(claimsP2p, { playlists: 60, segments: 6, parts: 0 }, ctx).checks).toEqual(["too_few_segments"]);
    // A p2p session claiming 100 s still expects 10 HTTP segments.
    const p2p = { ...base, assignedSource: "p2p" as const, watchSeconds: 100 };
    expect(fetchChecks(p2p, { playlists: 0, segments: 0, parts: 0 }, ctx).checks).toEqual(["no_media_fetched"]);
  });
});

describe("claimedSecondsUntil", () => {
  const s = { watchSeconds: 100, startedAt: new Date(0), lastHeartbeatAt: new Date(100_000) };
  test("sums beats received up to the window end", () => {
    const beats = humanBeats(5, 0).map((b) => ({ ...b, playedSeconds: 10 }));
    expect(claimedSecondsUntil(beats, beats[2]!.at, s)).toBe(30);
    expect(claimedSecondsUntil(beats, 0, s)).toBe(0);
  });
  test("without history, spreads the watch time over the session's life", () => {
    expect(claimedSecondsUntil([], 50_000, s)).toBe(50);
    expect(claimedSecondsUntil([], 500_000, s)).toBe(100);
    expect(claimedSecondsUntil([], -1, s)).toBe(0);
    expect(claimedSecondsUntil([], 50_000, { ...s, lastHeartbeatAt: null })).toBe(0);
  });
});
