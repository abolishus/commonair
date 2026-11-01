// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure re-score of an overturned exclusion group (`rescore.ts`). */
import { describe, expect, it } from "vite-plus/test";
import { exclusionCategoryOf } from "../src/constants.ts";
import { categorySignals, rescoredScore, rescoreStoredSession, type StoredVerdict } from "../src/rescore.ts";

const DECIDED = new Date("2026-10-30T12:00:00.000Z");
const before = (ms: number) => new Date(DECIDED.getTime() - ms);

const excluded = (reasons: string[], o: Partial<StoredVerdict> = {}): StoredVerdict => ({
  verdict: "excluded",
  reasons,
  startedAt: before(3_600_000),
  endedAt: before(1_800_000),
  heartbeats: 20,
  ...o,
});

describe("rescoreStoredSession", () => {
  it("one category among several reasons: drops it, stays excluded and moves group", () => {
    const r = rescoreStoredSession(excluded(["datacenter_ip", "headless", "fetch_pattern"]), "datacenter", DECIDED);
    expect(r).toEqual({
      verdict: "excluded",
      reasons: ["headless", "fetch_pattern", "allowed_on_appeal"],
      dropped: ["datacenter_ip"],
    });
    expect(exclusionCategoryOf(r!.reasons)).toBe("automation");
  });

  it("drops every signal of the category (both concurrency codes)", () => {
    const r = rescoreStoredSession(
      excluded(["device_concurrency", "account_concurrency", "datacenter_ip"]),
      "concurrency",
      DECIDED,
    );
    expect(r?.reasons).toEqual(["datacenter_ip", "allowed_on_appeal"]);
    expect(r?.dropped).toEqual(["device_concurrency", "account_concurrency"]);
  });

  it("the only reason: verified, with allowed_on_appeal", () => {
    expect(rescoreStoredSession(excluded(["datacenter_ip"]), "datacenter", DECIDED)).toEqual({
      verdict: "verified",
      reasons: ["allowed_on_appeal"],
      dropped: ["datacenter_ip"],
    });
  });

  it("keeps fetch_unjudged (it records what was not checked) and still verifies", () => {
    const r = rescoreStoredSession(excluded(["datacenter_ip", "fetch_unjudged"]), "datacenter", DECIDED);
    expect(r).toMatchObject({ verdict: "verified", reasons: ["allowed_on_appeal", "fetch_unjudged"] });
  });

  it("insufficient_heartbeats left: pending", () => {
    const r = rescoreStoredSession(
      excluded(["datacenter_ip", "fetch_unjudged", "insufficient_heartbeats"]),
      "datacenter",
      DECIDED,
    );
    expect(r).toMatchObject({
      verdict: "pending",
      reasons: ["allowed_on_appeal", "fetch_unjudged", "insufficient_heartbeats"],
    });
  });

  it("too few heartbeats on record: pending with insufficient_heartbeats", () => {
    const r = rescoreStoredSession(excluded(["datacenter_ip"], { heartbeats: 2 }), "datacenter", DECIDED);
    expect(r).toMatchObject({ verdict: "pending", reasons: ["allowed_on_appeal", "insufficient_heartbeats"] });
  });

  it("media_unconfirmed left: pending, unless the overturn allowed fetch_pattern", () => {
    expect(rescoreStoredSession(excluded(["datacenter_ip", "media_unconfirmed"]), "datacenter", DECIDED)).toMatchObject(
      { verdict: "pending", reasons: ["allowed_on_appeal", "media_unconfirmed"] },
    );
    expect(
      rescoreStoredSession(excluded(["fetch_pattern", "media_unconfirmed"]), "playback_pattern", DECIDED),
    ).toMatchObject({ verdict: "verified", reasons: ["allowed_on_appeal"] });
  });

  it("an earlier allowance's allowed_on_appeal is not doubled", () => {
    const r = rescoreStoredSession(excluded(["datacenter_ip", "allowed_on_appeal"]), "datacenter", DECIDED);
    expect(r?.reasons).toEqual(["allowed_on_appeal"]);
  });

  it("a session started after the decision is never touched", () => {
    const s = excluded(["datacenter_ip"], { startedAt: new Date(DECIDED.getTime() + 1) });
    expect(rescoreStoredSession(s, "datacenter", DECIDED)).toBeNull();
    // Started exactly at the decision: covered (as allowances are).
    expect(rescoreStoredSession({ ...s, startedAt: DECIDED }, "datacenter", DECIDED)).not.toBeNull();
  });

  it("another category's session is not touched, even if it carries this category's signal", () => {
    expect(rescoreStoredSession(excluded(["headless", "datacenter_ip"]), "datacenter", DECIDED)).toBeNull();
  });

  it("only excluded, ended sessions", () => {
    expect(
      rescoreStoredSession(excluded(["datacenter_ip"], { verdict: "verified" }), "datacenter", DECIDED),
    ).toBeNull();
    expect(rescoreStoredSession(excluded(["datacenter_ip"], { verdict: "pending" }), "datacenter", DECIDED)).toBeNull();
    expect(rescoreStoredSession(excluded(["datacenter_ip"], { endedAt: null }), "datacenter", DECIDED)).toBeNull();
  });

  it("an empty group: nothing to re-score", () => {
    const sessions: StoredVerdict[] = [];
    expect(sessions.flatMap((s) => rescoreStoredSession(s, "datacenter", DECIDED) ?? [])).toEqual([]);
    // Null reasons are an `other` session, never a datacenter one.
    expect(rescoreStoredSession(excluded([], { reasons: null }), "datacenter", DECIDED)).toBeNull();
  });

  it("other: drops the codes no current signal knows", () => {
    expect(rescoreStoredSession(excluded(["retired_code", "fetch_unjudged"]), "other", DECIDED)).toEqual({
      verdict: "verified",
      reasons: ["allowed_on_appeal", "fetch_unjudged"],
      dropped: ["retired_code"],
    });
    // An unknown code left by another category's overturn keeps the session excluded, as `other`.
    const r = rescoreStoredSession(excluded(["datacenter_ip", "retired_code"]), "datacenter", DECIDED);
    expect(r).toMatchObject({ verdict: "excluded", reasons: ["retired_code", "allowed_on_appeal"] });
    expect(exclusionCategoryOf(r!.reasons)).toBe("other");
  });

  it("idempotent: a second overturn of the same group changes nothing", () => {
    const first = rescoreStoredSession(excluded(["datacenter_ip", "headless"]), "datacenter", DECIDED);
    const after = excluded(first!.reasons, { verdict: first!.verdict });
    expect(rescoreStoredSession(after, "datacenter", DECIDED)).toBeNull();
    const restored = rescoreStoredSession(excluded(["datacenter_ip"]), "datacenter", DECIDED);
    expect(
      rescoreStoredSession(excluded(restored!.reasons, { verdict: restored!.verdict }), "datacenter", DECIDED),
    ).toBeNull();
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
  });
});
