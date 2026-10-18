// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { chatToViewerAnomaly, followBurst, percentile, raidIntegrity, type FollowFact } from "../src/channel.ts";
import { checkReceipt, relayStanding } from "../src/relay.ts";
import { scoreSession } from "../src/score.ts";
import type { FetchSummary, HeartbeatSample, ScoringContext, SessionFacts } from "../src/types.ts";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const session = (o: Partial<SessionFacts> = {}): SessionFacts => ({
  id: "00000000-0000-7000-8000-000000000001",
  channelId: "00000000-0000-7000-8000-0000000000c1",
  userId: null,
  deviceHash: "dev",
  asn: null,
  datacenter: null,
  userAgent: CHROME,
  fingerprint: { webdriver: false, plugins: 5, webgl: true, innerWidth: 1280, innerHeight: 720, audio: true },
  assignedSource: "origin",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  heartbeats: 6,
  watchSeconds: 60,
  segmentsFetched: 60,
  bytesHttp: 1000,
  bytesP2p: 0,
  ...o,
});
const ctx = (o: Partial<ScoringContext> = {}): ScoringContext => ({
  sessionExcludeScore: 0.7,
  maxSessionsPerDevice: 3,
  device: { rank: 1, concurrent: 1 },
  account: null,
  segmentDurationSeconds: 1,
  partsPerSegment: 5,
  ...o,
});
const fetches: FetchSummary = { playlists: 60, segments: 60, parts: 0 };
const beats = (n: number): HeartbeatSample[] =>
  Array.from({ length: n }, (_, i) => ({
    at: 1_000_000 + i * 10_000 + ((i * 37) % 200),
    playedSeconds: 10,
    bufferSeconds: 2 + (i % 3),
    visible: true,
    muted: false,
    stalls: 0,
    bytesHttp: 0,
    bytesP2p: 0,
  }));

describe("scoreSession verdicts", () => {
  test("a clean session with ≥ 3 heartbeats is verified with no reasons", () => {
    expect(scoreSession(session(), beats(6), fetches, ctx())).toEqual({
      verdict: "verified",
      score: 0,
      reasons: [],
      signals: [],
    });
  });

  test("fewer than 3 heartbeats stays pending", () => {
    const r = scoreSession(session({ heartbeats: 2 }), beats(2), fetches, ctx());
    expect(r).toMatchObject({ verdict: "pending", reasons: ["insufficient_heartbeats"] });
  });

  test("the database heartbeat counter counts even when Valkey history is gone", () => {
    expect(scoreSession(session({ heartbeats: 5 }), [], fetches, ctx()).verdict).toBe("verified");
  });

  test("a datacenter session alone is not excluded (0.6); with corroboration it is, even before 3 beats", () => {
    const alone = scoreSession(session({ datacenter: "Example Cloud" }), beats(6), fetches, ctx());
    expect(alone).toMatchObject({ verdict: "verified", score: 0.6, reasons: ["datacenter_ip"] });
    const r = scoreSession(
      session({ datacenter: "Example Cloud", heartbeats: 0, fingerprint: { webdriver: true } }),
      [],
      fetches,
      ctx(),
    );
    expect(r).toMatchObject({ verdict: "excluded", reasons: ["datacenter_ip", "headless"] });
    expect(r.score).toBeCloseTo(0.84, 6);
  });

  test("a privacy relay is a weak signal: never fatal alone, below exclusion even with a headless flag", () => {
    const relay = session({ datacenter: "privacy_relay:Example Relay" });
    expect(scoreSession(relay, beats(6), fetches, ctx())).toMatchObject({
      verdict: "verified",
      score: 0.3,
      reasons: ["privacy_relay"],
    });
    const plusWebdriver = scoreSession({ ...relay, fingerprint: { webdriver: true } }, beats(6), fetches, ctx());
    expect(plusWebdriver.score).toBeCloseTo(0.72, 6);
    // The default threshold is 0.7, so two weak signals still exclude: never *alone*.
    expect(plusWebdriver.verdict).toBe("excluded");
  });

  test("a weak signal alone keeps the session verified but explained", () => {
    const r = scoreSession(session({ fingerprint: { webdriver: true } }), beats(6), fetches, ctx());
    expect(r).toMatchObject({ verdict: "verified", score: 0.6, reasons: ["headless"] });
  });

  test("weak signals combine to an exclusion, strongest reason first", () => {
    const r = scoreSession(
      session({ fingerprint: { webdriver: true } }),
      beats(6).map((b) => ({ ...b, playedSeconds: 16 })),
      fetches,
      ctx(),
    );
    expect(r.verdict).toBe("excluded");
    expect(r.score).toBeCloseTo(0.8, 6);
    expect(r.reasons).toEqual(["headless", "heartbeat_inconsistent"]);
  });

  test("a background tab (hidden and muted) is not a bot, even with one weak flag", () => {
    const hidden = beats(12).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000, visible: false, muted: true }));
    const r = scoreSession(session({ fingerprint: { webdriver: true } }), hidden, fetches, ctx());
    // 1 − 0.4 × 0.75 = 0.7: not above the threshold. Clamped (perfectly regular) hidden beats add nothing.
    expect(r).toMatchObject({ verdict: "verified", reasons: ["headless", "heartbeat_inconsistent"] });
    expect(r.score).toBeCloseTo(0.7, 6);
    expect(r.signals[1]!.details.checks).toEqual(["never_visible_and_muted"]);
  });

  test("exactly the threshold is not above it", () => {
    const r = scoreSession(
      session({ fingerprint: { webdriver: true } }),
      beats(6),
      fetches,
      ctx({ sessionExcludeScore: 0.6 }),
    );
    expect(r.verdict).toBe("verified");
  });

  test("the fourth concurrent session on a device is excluded", () => {
    const r = scoreSession(session(), beats(6), fetches, ctx({ device: { rank: 4, concurrent: 4 } }));
    expect(r).toMatchObject({ verdict: "excluded", reasons: ["device_concurrency"] });
    const acc = scoreSession(session({ userId: "u" }), beats(6), fetches, ctx({ account: { rank: 5, concurrent: 6 } }));
    expect(acc.reasons).toEqual(["account_concurrency"]);
  });

  test("a playlist-polling bot is excluded by its fetch pattern plus periodic beats", () => {
    const periodic = beats(12).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000 }));
    const r = scoreSession(session({ heartbeats: 12 }), periodic, { playlists: 120, segments: 0, parts: 0 }, ctx());
    expect(r.verdict).toBe("excluded");
    expect(r.reasons).toEqual(["fetch_pattern", "heartbeat_inconsistent"]);
  });

  test("the latest heartbeat fingerprint is merged over the session-start one", () => {
    const b = beats(6);
    b[5] = { ...b[5]!, fingerprint: { webdriver: true } };
    expect(scoreSession(session(), b, fetches, ctx()).reasons).toEqual(["headless"]);
  });
});

describe("scoreSession: fetch-less heartbeat bots never verify", () => {
  test("origin counters with no media at all exclude (claims playback, fetched nothing)", () => {
    const r = scoreSession(session(), beats(6), { playlists: 0, segments: 0, parts: 0 }, ctx());
    expect(r).toMatchObject({ verdict: "excluded", score: 0.9, reasons: ["fetch_pattern"] });
    expect(r.signals[0]!.details.checks).toEqual(["no_media_fetched"]);
  });

  test("far too few segments: weak score, but held pending (media_unconfirmed), never verified", () => {
    const r = scoreSession(session(), beats(6), { playlists: 60, segments: 10, parts: 0 }, ctx());
    expect(r).toMatchObject({ verdict: "pending", reasons: ["fetch_pattern", "media_unconfirmed"], score: 0.6 });
  });

  test("database counter only: zero segments holds pending; any segment lets it verify (parts unknown)", () => {
    const db0 = scoreSession(session(), beats(6), { playlists: null, segments: 0, parts: null }, ctx());
    expect(db0).toMatchObject({ verdict: "pending", score: 0, reasons: ["media_unconfirmed"] });
    // A low-latency player fetches mostly parts the database counter does not see: no ratio check.
    const db3 = scoreSession(session(), beats(6), { playlists: null, segments: 3, parts: null }, ctx());
    expect(db3).toMatchObject({ verdict: "verified", reasons: [] });
  });

  test("short watch times are not judged", () => {
    const r = scoreSession(session({ watchSeconds: 9 }), beats(6), { playlists: 0, segments: 0, parts: 0 }, ctx());
    expect(r.verdict).toBe("verified");
  });

  test("relay sessions are judged by their relay's receipts", () => {
    const relay = session({ assignedSource: "relay" });
    expect(scoreSession(relay, beats(6), { relayObjects: 0, claimedSeconds: 60 }, ctx())).toMatchObject({
      verdict: "excluded",
      reasons: ["fetch_pattern"],
    });
    expect(scoreSession(relay, beats(6), { relayObjects: 10, claimedSeconds: 60 }, ctx()).verdict).toBe("pending");
    // A part-only player has ~5 objects per second: never "too many" for relays.
    expect(scoreSession(relay, beats(6), { relayObjects: 300, claimedSeconds: 60 }, ctx())).toMatchObject({
      verdict: "verified",
      reasons: [],
    });
    // No receipts for the window: unknown, not judged.
    expect(scoreSession(relay, beats(6), null, ctx()).verdict).toBe("verified");
  });

  test("CDN sessions have no per-session accounting and are never judged on fetches", () => {
    const cdn = session({ assignedSource: "cdn" });
    expect(scoreSession(cdn, beats(6), null, ctx()).verdict).toBe("verified");
    expect(scoreSession(cdn, beats(6), { playlists: 0, segments: 0, parts: 0 }, ctx()).verdict).toBe("verified");
  });
});

describe("scoreSession: allowances (appeal stickiness)", () => {
  const T = 1_000_000 + 5 * 10_000;
  test("covered signals no longer count; the reason says why", () => {
    const dc = session({ datacenter: "Example Cloud", fingerprint: { webdriver: true } });
    expect(scoreSession(dc, beats(6), fetches, ctx()).verdict).toBe("excluded");
    const r = scoreSession(
      dc,
      beats(6),
      fetches,
      ctx({ allowance: { since: T, codes: ["datacenter_ip", "headless"] } }),
    );
    expect(r).toMatchObject({ verdict: "verified", score: 0, reasons: ["allowed_on_appeal"] });
  });

  test("a signal not covered is new evidence and can exclude again", () => {
    const r = scoreSession(
      session({ datacenter: "Example Cloud" }),
      beats(6),
      fetches,
      ctx({ allowance: { since: T, codes: ["datacenter_ip"] }, device: { rank: 5, concurrent: 5 } }),
    );
    expect(r).toMatchObject({ verdict: "excluded", reasons: ["device_concurrency", "allowed_on_appeal"] });
  });

  test("heartbeat checks only look at beats after the decision", () => {
    const periodic = beats(24).map((b, i) => ({ ...b, at: 1_000_000 + i * 10_000, bufferSeconds: 2 }));
    const before = periodic.slice(0, 12);
    const since = before.at(-1)!.at;
    const webdriver = session({ fingerprint: { webdriver: true }, heartbeats: 24 });
    // Old periodic beats were part of what was appealed: not counted again.
    const onlyOld = scoreSession(webdriver, before, fetches, ctx({ allowance: { since, codes: ["headless"] } }));
    expect(onlyOld.reasons).toEqual(["allowed_on_appeal"]);
    // New periodic beats after the decision are new evidence.
    const withNew = scoreSession(webdriver, periodic, fetches, ctx({ allowance: { since, codes: ["headless"] } }));
    expect(withNew.reasons).toEqual(["heartbeat_inconsistent", "allowed_on_appeal"]);
    expect(withNew.verdict).toBe("excluded");
  });

  test("an allowed fetch pattern also lifts the media_unconfirmed hold", () => {
    const r = scoreSession(
      session(),
      beats(6),
      { playlists: 60, segments: 10, parts: 0 },
      ctx({ allowance: { since: 0, codes: ["fetch_pattern"] } }),
    );
    expect(r).toMatchObject({ verdict: "verified", reasons: ["allowed_on_appeal"] });
  });
});

describe("chatToViewerAnomaly", () => {
  const platform = Array.from({ length: 40 }, (_, i) => 0.05 + i * 0.005);

  test("a quiet chat on a channel far below its baseline and the platform is anomalous", () => {
    const r = chatToViewerAnomaly({ viewers: 1000, chatters: 2, baselineRatio: 0.1, platformRatios: platform });
    expect(r.anomalous).toBe(true);
    expect(r.score).toBeCloseTo(0.98, 6);
    expect(r.impliedViewers).toBe(20);
    expect(r.checks).toEqual({ baseline: true, platform: true });
  });

  test("normal chat activity is not anomalous", () => {
    expect(
      chatToViewerAnomaly({ viewers: 1000, chatters: 90, baselineRatio: 0.1, platformRatios: platform }).anomalous,
    ).toBe(false);
  });

  test("small channels are never judged", () => {
    expect(
      chatToViewerAnomaly({ viewers: 49, chatters: 0, baselineRatio: 0.1, platformRatios: platform }).anomalous,
    ).toBe(false);
  });

  test("both references must agree when both exist; one is enough when the other is missing", () => {
    // Below the platform but in line with the channel's own (quiet) baseline.
    expect(
      chatToViewerAnomaly({ viewers: 500, chatters: 5, baselineRatio: 0.012, platformRatios: platform }).anomalous,
    ).toBe(false);
    expect(
      chatToViewerAnomaly({ viewers: 500, chatters: 1, baselineRatio: null, platformRatios: platform }).anomalous,
    ).toBe(true);
    expect(chatToViewerAnomaly({ viewers: 500, chatters: 1, baselineRatio: 0.1, platformRatios: [] }).anomalous).toBe(
      true,
    );
    expect(chatToViewerAnomaly({ viewers: 500, chatters: 0, baselineRatio: null, platformRatios: [] })).toMatchObject({
      anomalous: false,
      score: 0,
      reference: null,
    });
  });

  test("percentile interpolates and ignores non-finite values", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([5, Number.NaN], 0)).toBe(5);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe("followBurst", () => {
  const t0 = new Date("2026-02-01T12:00:00Z").getTime();
  const follow = (i: number, o: Partial<FollowFact> = {}): FollowFact => ({
    followerId: `u${i}`,
    channelId: "c",
    createdAt: new Date(t0 + (i % 60) * 500),
    accountCreatedAt: new Date(t0 - 365 * 86_400_000),
    priorViewingSeconds: 600,
    ...o,
  });
  const opts = { perMinute: 30, minAccountAgeDays: 7 };

  test("no burst at or under the per-minute limit", () => {
    const list = Array.from({ length: 30 }, (_, i) => follow(i, { priorViewingSeconds: 0 }));
    expect(followBurst(list, opts)).toEqual({ bursts: [], excluded: [] });
  });

  test("in a burst, fresh accounts and never-watched followers are excluded; established viewers are kept", () => {
    const list = [
      ...Array.from({ length: 20 }, (_, i) => follow(i, { accountCreatedAt: new Date(t0 - 86_400_000) })),
      ...Array.from({ length: 10 }, (_, i) => follow(100 + i, { priorViewingSeconds: 0 })),
      ...Array.from({ length: 5 }, (_, i) => follow(200 + i)),
    ];
    const r = followBurst(list, opts);
    expect(r.bursts).toEqual([{ minuteStart: new Date(t0), follows: 35, excluded: 30 }]);
    expect(r.excluded).toHaveLength(30);
    expect(r.excluded.some((f) => f.followerId.startsWith("u20"))).toBe(false);
  });

  test("follows already excluded still count toward the burst but are not returned again", () => {
    const list = Array.from({ length: 31 }, (_, i) => follow(i, { priorViewingSeconds: 0, alreadyExcluded: i < 20 }));
    const r = followBurst(list, opts);
    expect(r.bursts[0]!.follows).toBe(31);
    expect(r.excluded).toHaveLength(11);
  });

  test("bursts are bucketed per clock minute", () => {
    const a = Array.from({ length: 31 }, (_, i) =>
      follow(i, { priorViewingSeconds: 0, createdAt: new Date(t0 + i * 1000) }),
    );
    const b = Array.from({ length: 31 }, (_, i) =>
      follow(100 + i, { priorViewingSeconds: 0, createdAt: new Date(t0 + 30_000 + i * 1000) }),
    );
    // Spread over two minutes: neither minute exceeds 30 when split evenly.
    const r = followBurst([...a.slice(0, 15), ...b.slice(16)], opts);
    expect(r.bursts).toEqual([]);
  });
});

describe("raidIntegrity", () => {
  test("a raid carries at most the verified viewers of the source", () => {
    expect(raidIntegrity(50, 80)).toEqual({ ok: true, allowedViewers: 50, overstatement: 0 });
    expect(raidIntegrity(80, 80).ok).toBe(true);
    expect(raidIntegrity(500, 80)).toEqual({ ok: false, allowedViewers: 80, overstatement: 420 });
    expect(raidIntegrity(-3, 0)).toEqual({ ok: true, allowedViewers: 0, overstatement: 0 });
  });
});

describe("checkReceipt", () => {
  test("within tolerance: verified for min(reported, issued)", () => {
    expect(checkReceipt(1100, 1000, 0.1)).toEqual({
      status: "verified",
      bytesVerified: 1000,
      overReportRatio: expect.closeTo(0.1, 9),
      issuance: "complete",
    });
    expect(checkReceipt(800, 1000, 0.1)).toEqual({
      status: "verified",
      bytesVerified: 800,
      overReportRatio: expect.closeTo(-0.2, 9),
      issuance: "complete",
    });
  });

  test("incomplete issuance (origin restart) is unknown: paid for issued bytes only, never an over-report", () => {
    expect(checkReceipt(5000, 1000, 0.1, false)).toEqual({
      status: "verified",
      bytesVerified: 1000,
      overReportRatio: null,
      issuance: "unknown",
    });
    expect(checkReceipt(5000, null, 0.1, false)).toEqual({
      status: "verified",
      bytesVerified: 0,
      overReportRatio: null,
      issuance: "unknown",
    });
    // Within tolerance it is an ordinary verification even with gaps.
    expect(checkReceipt(1000, 1000, 0.1, false)).toMatchObject({ status: "verified", issuance: "complete" });
    expect(checkReceipt(0, null, 0.1, false)).toMatchObject({ status: "verified", bytesVerified: 0 });
  });

  test("beyond tolerance: rejected with the over-report ratio", () => {
    expect(checkReceipt(1101, 1000, 0.1)).toMatchObject({
      status: "rejected",
      bytesVerified: 0,
      reason: "over_report",
    });
    expect(checkReceipt(5000, 1000, 0.1).overReportRatio).toBe(4);
  });

  test("bytes against no issuance are rejected; an empty receipt is verified as zero", () => {
    expect(checkReceipt(10, null, 0.1)).toEqual({
      status: "rejected",
      bytesVerified: 0,
      overReportRatio: null,
      reason: "no_issuance",
    });
    expect(checkReceipt(10, 0, 0.1).status).toBe("rejected");
    expect(checkReceipt(0, null, 0.1)).toEqual({
      status: "verified",
      bytesVerified: 0,
      overReportRatio: 0,
      issuance: "complete",
    });
    expect(checkReceipt(0, 50, 0.1)).toMatchObject({ status: "verified", bytesVerified: 0, overReportRatio: -1 });
  });
});

describe("relayStanding", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
  const h = (
    m: number,
    ratio: number | null,
    status: "verified" | "rejected" = ratio !== null && ratio > 0.1 ? "rejected" : "verified",
  ) => ({
    periodEnd: at(m),
    status,
    overReportRatio: ratio,
  });

  test("a clean history stands", () => {
    expect(relayStanding([h(1, 0), h(2, 0.05), h(3, -0.1)], 0.1)).toMatchObject({
      suspend: false,
      reason: null,
      overReportingPeriods: 0,
    });
    expect(relayStanding([], 0.1)).toMatchObject({ suspend: false, worstRatio: null });
  });

  test("one modest over-report is tolerated; two in the last five suspend", () => {
    expect(relayStanding([h(1, 0.2), h(2, 0), h(3, 0)], 0.1).suspend).toBe(false);
    expect(relayStanding([h(1, 0.2), h(2, 0), h(3, 0.15)], 0.1)).toMatchObject({
      suspend: true,
      reason: "repeated_over_report",
    });
  });

  test("only the last five periods count", () => {
    const history = [h(1, 0.2), h(2, 0.2), h(3, 0), h(4, 0), h(5, 0), h(6, 0), h(7, 0)];
    expect(relayStanding(history, 0.1)).toMatchObject({ suspend: false, periodsConsidered: 5 });
  });

  test("a single period above 3× tolerance suspends", () => {
    expect(relayStanding([h(1, 0.31)], 0.1)).toMatchObject({ suspend: true, reason: "gross_over_report" });
    expect(relayStanding([h(1, 0.3)], 0.1).suspend).toBe(false);
  });

  test("bytes against no issuance count as an unbounded over-report", () => {
    expect(relayStanding([h(1, null, "rejected")], 0.1)).toMatchObject({
      suspend: true,
      reason: "gross_over_report",
      worstRatio: null,
    });
  });

  test("a verified receipt with unknown issuance (null ratio) counts as clean", () => {
    expect(relayStanding([h(1, null, "verified"), h(2, null, "verified")], 0.1)).toMatchObject({
      suspend: false,
      overReportingPeriods: 0,
      worstRatio: 0,
    });
  });

  test("after reinstatement only periods that started at or after it count", () => {
    const withStart = (m: number, ratio: number | null) => ({ ...h(m, ratio), periodStart: at(m - 1) });
    const history = [withStart(1, 0.5), withStart(2, null), withStart(5, 0), withStart(6, 0.05)];
    expect(relayStanding(history, 0.1).suspend).toBe(true);
    // Reinstated at minute 3: the gross over-reports before it are forgiven.
    expect(relayStanding(history, 0.1, at(3))).toMatchObject({ suspend: false, periodsConsidered: 2 });
    // A period straddling the reinstatement (started before it) is not counted either.
    expect(relayStanding([withStart(4, 0.5)], 0.1, new Date(at(3).getTime() + 30_000)).suspend).toBe(false);
    // Fresh over-reporting after reinstatement still suspends.
    expect(relayStanding([...history, withStart(7, 0.4)], 0.1, at(3))).toMatchObject({
      suspend: true,
      reason: "gross_over_report",
    });
    // Exactly at the boundary counts; an empty post-reinstatement history stands.
    expect(relayStanding([withStart(4, 0.5)], 0.1, at(3)).suspend).toBe(true);
    expect(relayStanding(history, 0.1, at(60))).toMatchObject({ suspend: false, periodsConsidered: 0 });
  });
});
