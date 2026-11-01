// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure re-score of an overturned exclusion group (`rescore.ts`, batch 7 decision (g)). */
import { describe, expect, it } from "vite-plus/test";
import { exclusionCategoryOf } from "../src/constants.ts";
import {
  categorySignals,
  coveredBy,
  overThreshold,
  rescoredScore,
  rescoreStoredSession,
  type RescoreWeights,
  type StoredVerdict,
} from "../src/rescore.ts";
import { scoreSession } from "../src/score.ts";
import type { FetchSummary, HeartbeatSample, ScoringContext, SessionFacts } from "../src/types.ts";

const DECIDED = new Date("2026-10-30T12:00:00.000Z");
const before = (ms: number) => new Date(DECIDED.getTime() - ms);
/** The seeded `integrity.thresholds.sessionExcludeScore`. */
const THRESHOLD = 0.7;

/** Flag scores as the scorer stores them (`DATACENTER_SCORE`, `CONCURRENCY_SCORE`, …). */
const SCORES: Record<string, number> = {
  device_concurrency: 0.9,
  account_concurrency: 0.9,
  headless: 0.8,
  datacenter_ip: 0.6,
  fetch_pattern: 0.5,
  heartbeat_inconsistent: 0.45,
  privacy_relay: 0.3,
};

/** Weights carrying a flag for every known signal in `reasons` (as the scorer writes them). */
const weights = (reasons: readonly string[], o: Partial<RescoreWeights> = {}): RescoreWeights => ({
  threshold: THRESHOLD,
  flagScores: new Map(reasons.flatMap((r) => (r in SCORES ? [[r, SCORES[r] as number] as const] : []))),
  ...o,
});

const excluded = (reasons: string[], o: Partial<StoredVerdict> = {}): StoredVerdict => ({
  verdict: "excluded",
  reasons,
  startedAt: before(3_600_000),
  endedAt: before(1_800_000),
  heartbeats: 20,
  ...o,
});

/** Re-score with the flags the session's own reasons carry. */
const rescore = (s: StoredVerdict, category: Parameters<typeof rescoreStoredSession>[1], o?: Partial<RescoreWeights>) =>
  rescoreStoredSession(s, category, DECIDED, weights(s.reasons ?? [], o));

describe("rescoreStoredSession: the threshold rule", () => {
  it("one category overturned, the remainder below the threshold: verified, the remainder still listed", () => {
    const r = rescore(excluded(["datacenter_ip", "fetch_pattern"]), "datacenter");
    expect(r).toEqual({
      verdict: "verified",
      reasons: ["fetch_pattern", "allowed_on_appeal"],
      dropped: ["datacenter_ip"],
      score: 0.5,
    });
  });

  it("one category overturned, the remainder above the threshold: stays excluded and moves group", () => {
    const r = rescore(excluded(["datacenter_ip", "headless", "fetch_pattern"]), "datacenter");
    expect(r).toEqual({
      verdict: "excluded",
      reasons: ["headless", "fetch_pattern", "allowed_on_appeal"],
      dropped: ["datacenter_ip"],
      score: 0.9,
    });
    expect(exclusionCategoryOf(r!.reasons)).toBe("automation");
  });

  it("two sub-threshold signals left combine (noisy-OR) over the threshold: excluded", () => {
    // 1 − 0.4 · 0.5 = 0.8 > 0.7, although neither alone crosses it.
    const r = rescore(excluded(["device_concurrency", "datacenter_ip", "fetch_pattern"]), "concurrency");
    expect(r).toMatchObject({ verdict: "excluded", reasons: ["datacenter_ip", "fetch_pattern", "allowed_on_appeal"] });
    expect(r?.score).toBeCloseTo(0.8, 6);
  });

  it("a remainder at exactly the threshold is not over it (the scorer excludes only above)", () => {
    const s = excluded(["device_concurrency", "datacenter_ip"]);
    expect(rescore(s, "concurrency", { threshold: 0.6 })).toMatchObject({ verdict: "verified", score: 0.6 });
    expect(rescore(s, "concurrency", { threshold: 0.599999 })).toMatchObject({ verdict: "excluded", score: 0.6 });
    expect(rescore(s, "concurrency", { threshold: 0.600001 })).toMatchObject({ verdict: "verified" });
  });

  it("threshold edges: the governance range ends (just above 0 and 1)", () => {
    const s = excluded(["device_concurrency", "privacy_relay"]);
    // 0.3 left: over a near-zero threshold, never over 1.
    expect(rescore(s, "concurrency", { threshold: 0.000001 })?.verdict).toBe("excluded");
    expect(rescore(s, "concurrency", { threshold: 1 })?.verdict).toBe("verified");
    // Nothing left scores 0, which no allowed threshold (> 0) excludes.
    expect(rescore(excluded(["device_concurrency"]), "concurrency", { threshold: 0.000001 })).toMatchObject({
      verdict: "verified",
      score: 0,
    });
  });

  it("drops every signal of the category (both concurrency codes) before weighing", () => {
    const r = rescore(excluded(["device_concurrency", "account_concurrency", "datacenter_ip"]), "concurrency");
    expect(r).toMatchObject({ verdict: "verified", reasons: ["datacenter_ip", "allowed_on_appeal"], score: 0.6 });
    expect(r?.dropped).toEqual(["device_concurrency", "account_concurrency"]);
    // With a threshold under 0.6 the datacenter signal alone keeps it excluded, now as `datacenter`.
    const kept = rescore(excluded(["device_concurrency", "account_concurrency", "datacenter_ip"]), "concurrency", {
      threshold: 0.5,
    });
    expect(kept?.verdict).toBe("excluded");
    expect(exclusionCategoryOf(kept!.reasons)).toBe("datacenter");
  });

  it("several categories overturned in turn: each overturn weighs what the previous left", () => {
    const start = excluded(["device_concurrency", "headless", "datacenter_ip", "fetch_pattern"]);
    const first = rescore(start, "concurrency");
    expect(first).toMatchObject({
      verdict: "excluded",
      reasons: ["headless", "datacenter_ip", "fetch_pattern", "allowed_on_appeal"],
    });
    const second = rescore(excluded(first!.reasons), "automation");
    // 1 − 0.4 · 0.5 = 0.8: still over the threshold, now in `datacenter`.
    expect(second?.verdict).toBe("excluded");
    expect(exclusionCategoryOf(second!.reasons)).toBe("datacenter");
    const third = rescore(excluded(second!.reasons), "datacenter");
    expect(third).toMatchObject({
      verdict: "verified",
      reasons: ["fetch_pattern", "allowed_on_appeal"],
      dropped: ["datacenter_ip"],
      score: 0.5,
    });
  });

  it("several sessions, one overturn: each is weighed on its own flags", () => {
    const sessions = [
      excluded(["datacenter_ip"]),
      excluded(["datacenter_ip", "fetch_pattern"]),
      excluded(["datacenter_ip", "heartbeat_inconsistent", "fetch_pattern"]),
    ];
    expect(sessions.map((s) => rescore(s, "datacenter")?.verdict)).toEqual(["verified", "verified", "excluded"]);
  });

  it("an overturn of a category the session never had covers nothing", () => {
    expect(rescore(excluded(["headless", "fetch_pattern"]), "datacenter")).toBeNull();
    expect(rescore(excluded(["headless", "fetch_pattern"]), "concurrency")).toBeNull();
    expect(coveredBy(excluded(["headless"]), "datacenter", DECIDED)).toBe(false);
  });

  it("fail closed: a signal left with no flag to weigh it keeps the session excluded", () => {
    const s = excluded(["datacenter_ip", "fetch_pattern"]);
    const r = rescoreStoredSession(s, "datacenter", DECIDED, {
      threshold: THRESHOLD,
      flagScores: new Map([["datacenter_ip", 0.6]]),
    });
    expect(r).toMatchObject({ verdict: "excluded", reasons: ["fetch_pattern", "allowed_on_appeal"], score: 0 });
  });

  it("keeps fetch_unjudged (it records what was not checked) and still verifies", () => {
    const r = rescore(excluded(["datacenter_ip", "fetch_unjudged"]), "datacenter");
    expect(r).toMatchObject({ verdict: "verified", reasons: ["allowed_on_appeal", "fetch_unjudged"] });
  });

  it("insufficient_heartbeats left: pending", () => {
    const r = rescore(excluded(["datacenter_ip", "fetch_unjudged", "insufficient_heartbeats"]), "datacenter");
    expect(r).toMatchObject({
      verdict: "pending",
      reasons: ["allowed_on_appeal", "fetch_unjudged", "insufficient_heartbeats"],
    });
  });

  it("too few heartbeats on record: pending with insufficient_heartbeats, a sub-threshold signal still listed", () => {
    expect(rescore(excluded(["datacenter_ip"], { heartbeats: 2 }), "datacenter")).toMatchObject({
      verdict: "pending",
      reasons: ["allowed_on_appeal", "insufficient_heartbeats"],
    });
    expect(rescore(excluded(["datacenter_ip", "fetch_pattern"], { heartbeats: 2 }), "datacenter")).toMatchObject({
      verdict: "pending",
      reasons: ["fetch_pattern", "allowed_on_appeal", "insufficient_heartbeats"],
    });
  });

  it("media_unconfirmed left: pending, unless the overturn allowed fetch_pattern", () => {
    expect(rescore(excluded(["datacenter_ip", "media_unconfirmed"]), "datacenter")).toMatchObject({
      verdict: "pending",
      reasons: ["allowed_on_appeal", "media_unconfirmed"],
    });
    expect(rescore(excluded(["fetch_pattern", "media_unconfirmed"]), "playback_pattern")).toMatchObject({
      verdict: "verified",
      reasons: ["allowed_on_appeal"],
    });
  });

  it("an earlier allowance's allowed_on_appeal is not doubled", () => {
    expect(rescore(excluded(["datacenter_ip", "allowed_on_appeal"]), "datacenter")?.reasons).toEqual([
      "allowed_on_appeal",
    ]);
  });

  it("a session started after the decision is never touched", () => {
    const s = excluded(["datacenter_ip"], { startedAt: new Date(DECIDED.getTime() + 1) });
    expect(rescore(s, "datacenter")).toBeNull();
    // Started exactly at the decision: covered (as allowances are).
    expect(rescore({ ...s, startedAt: DECIDED }, "datacenter")).not.toBeNull();
  });

  it("another category's session is not touched, even if it carries this category's signal", () => {
    expect(rescore(excluded(["headless", "datacenter_ip"]), "datacenter")).toBeNull();
  });

  it("only excluded, ended sessions", () => {
    expect(rescore(excluded(["datacenter_ip"], { verdict: "verified" }), "datacenter")).toBeNull();
    expect(rescore(excluded(["datacenter_ip"], { verdict: "pending" }), "datacenter")).toBeNull();
    expect(rescore(excluded(["datacenter_ip"], { endedAt: null }), "datacenter")).toBeNull();
  });

  it("an empty group: nothing to re-score", () => {
    const sessions: StoredVerdict[] = [];
    expect(sessions.flatMap((s) => rescore(s, "datacenter") ?? [])).toEqual([]);
    // Null reasons are an `other` session, never a datacenter one.
    expect(rescore(excluded([], { reasons: null }), "datacenter")).toBeNull();
  });

  it("other: drops the codes no current signal knows; an unknown code left elsewhere keeps the session excluded", () => {
    expect(rescore(excluded(["retired_code", "fetch_unjudged"]), "other")).toEqual({
      verdict: "verified",
      reasons: ["allowed_on_appeal", "fetch_unjudged"],
      dropped: ["retired_code"],
      score: 0,
    });
    // An admin decision is not a score the threshold can weigh: fail closed, as `other`.
    const r = rescore(excluded(["datacenter_ip", "retired_code"]), "datacenter");
    expect(r).toMatchObject({ verdict: "excluded", reasons: ["retired_code", "allowed_on_appeal"] });
    expect(exclusionCategoryOf(r!.reasons)).toBe("other");
  });

  it("idempotent: a second overturn of the same group changes nothing", () => {
    const first = rescore(excluded(["datacenter_ip", "headless"]), "datacenter");
    expect(first?.verdict).toBe("excluded");
    expect(rescore(excluded(first!.reasons, { verdict: first!.verdict }), "datacenter")).toBeNull();
    const restored = rescore(excluded(["datacenter_ip", "fetch_pattern"]), "datacenter");
    expect(restored?.verdict).toBe("verified");
    expect(rescore(excluded(restored!.reasons, { verdict: restored!.verdict }), "datacenter")).toBeNull();
  });
});

describe("overThreshold: the live scorer's rule", () => {
  const CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const session: SessionFacts = {
    id: "00000000-0000-7000-8000-000000000001",
    channelId: "00000000-0000-7000-8000-0000000000c1",
    userId: null,
    deviceHash: "dev",
    asn: null,
    datacenter: "Example Cloud",
    userAgent: CHROME,
    fingerprint: { webdriver: false, plugins: 5, webgl: true, innerWidth: 1280, innerHeight: 720, audio: true },
    assignedSource: "origin",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    heartbeats: 6,
    watchSeconds: 60,
    segmentsFetched: 60,
    bytesHttp: 1000,
    bytesP2p: 0,
  };
  const fetches: FetchSummary = { playlists: 60, segments: 60, parts: 0 };
  const beats: HeartbeatSample[] = Array.from({ length: 6 }, (_, i) => ({
    at: 1_000_000 + i * 10_000 + ((i * 37) % 200),
    playedSeconds: 10,
    bufferSeconds: 2 + (i % 3),
    visible: true,
    muted: false,
    stalls: 0,
    bytesHttp: 0,
    bytesP2p: 0,
  }));
  const ctx = (sessionExcludeScore: number): ScoringContext => ({
    sessionExcludeScore,
    maxSessionsPerDevice: 3,
    device: { rank: 1, concurrent: 1 },
    account: null,
    segmentDurationSeconds: 1,
    partsPerSegment: 5,
  });

  it("agrees with scoreSession on the same score at, under and over the threshold", () => {
    // A datacenter session alone scores 0.6 in the scorer; the re-score weighs the same 0.6 flag.
    for (const threshold of [0.59, 0.599999, 0.6, 0.600001, 0.7]) {
      const live = scoreSession(session, beats, fetches, ctx(threshold));
      expect(live.score).toBe(0.6);
      expect(overThreshold(live.score, threshold)).toBe(live.verdict === "excluded");
      const r = rescoreStoredSession(excluded(["device_concurrency", "datacenter_ip"]), "concurrency", DECIDED, {
        threshold,
        flagScores: new Map([
          ["device_concurrency", 0.9],
          ["datacenter_ip", live.score],
        ]),
      });
      expect(r?.verdict === "excluded", String(threshold)).toBe(live.verdict === "excluded");
    }
  });
});

describe("categorySignals", () => {
  it("lists a category's signal codes; other has none", () => {
    expect(categorySignals("concurrency")).toEqual(["device_concurrency", "account_concurrency"]);
    expect(categorySignals("playback_pattern")).toEqual(["heartbeat_inconsistent", "fetch_pattern"]);
    expect(categorySignals("other")).toEqual([]);
  });
});

describe("rescoredScore", () => {
  it("noisy-OR of the flagged scores of the signals left; 0 when none", () => {
    const flags = new Map([
      ["headless", 0.5],
      ["datacenter_ip", 0.6],
    ]);
    expect(rescoredScore(["headless", "allowed_on_appeal"], flags)).toBe(0.5);
    expect(rescoredScore(["allowed_on_appeal"], flags)).toBe(0);
    expect(rescoredScore(["headless", "fetch_pattern"], flags)).toBe(0.5);
    expect(rescoredScore(["headless", "datacenter_ip"], flags)).toBe(0.8);
  });
});
