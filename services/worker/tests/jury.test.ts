// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The advisory jury's pure rules (ADR 0038): sampling exclusions and the 30-day window, the minor
 * rule, pool entries, pseudonyms per panel, the majority-disagree flag, settings and the draw's
 * determinism.
 */
import { JURY_RULES } from "@commonair/contracts/enums";
import { commit, newSalt, newSeed, verifyReveal } from "@commonair/draw";
import { describe, expect, test } from "vite-plus/test";
import { poolEntries, reportRuleRef } from "../src/jury/candidates.ts";
import { selectPanel } from "../src/jury/draw.ts";
import { caseMap, panelPseudonyms, SUBJECT_KEY } from "../src/jury/pseudonyms.ts";
import {
  candidateEntries,
  candidateKey,
  exclusionOf,
  inSampleWindow,
  isKnownAdult,
  panelPeriod,
  parseCandidateKey,
  sampleWindow,
  type CandidateFacts,
} from "../src/jury/sample.ts";
import { parseJurySettings } from "../src/jury/settings.ts";
import { countVotes, majorityDisagrees } from "../src/jury/votes.ts";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const DAY = 86_400_000;
const ADULT = { userId: "u-adult", birthDate: "1990-01-01" };

const kase = (v: Partial<CandidateFacts> = {}): CandidateFacts => ({
  kind: "moderation_case",
  id: "c1",
  closedAt: new Date(NOW.getTime() - DAY),
  status: "actioned",
  tier: "t1",
  listCategory: null,
  ruleRef: "decency.harassment@1",
  reportReason: null,
  reportSubjectType: null,
  parties: [ADULT],
  partiesUnknown: false,
  legalHold: false,
  ...v,
});
const report = (v: Partial<CandidateFacts> = {}): CandidateFacts =>
  kase({
    kind: "report",
    id: "r1",
    status: "dismissed",
    tier: null,
    ruleRef: "honesty.spam@1",
    reportReason: "spam",
    reportSubjectType: "chat_message",
    ...v,
  });

describe("sampling exclusions", () => {
  test("closed T1/T2 cases and resolved reports are sampled", () => {
    for (const status of ["cleared", "actioned", "dismissed", "confirmed"])
      for (const tier of ["t1", "t2"] as const) expect(exclusionOf(kase({ status, tier }), NOW)).toBeNull();
    for (const status of ["actioned", "dismissed"]) expect(exclusionOf(report({ status }), NOW)).toBeNull();
  });

  test("open, labelled and pending cases, and open reports, are not", () => {
    for (const status of ["open", "labelled", "dismissal_pending"])
      expect(exclusionOf(kase({ status }), NOW)).toBe("open");
    expect(exclusionOf(report({ status: "open" }), NOW)).toBe("open");
  });

  test("T0 and hash-list cases are never sampled", () => {
    expect(exclusionOf(kase({ tier: "t0", status: "confirmed" }), NOW)).toBe("t0");
    expect(exclusionOf(kase({ listCategory: "csam" }), NOW)).toBe("hash_list");
    expect(exclusionOf(kase({ listCategory: "ncii" }), NOW)).toBe("hash_list");
  });

  test("NCII and minor-safety clauses, whatever the origin, and reasons", () => {
    expect(exclusionOf(kase({ ruleRef: "decency.intimate-images@1" }), NOW)).toBe("ncii");
    expect(exclusionOf(kase({ ruleRef: "illegal.ncii@2" }), NOW)).toBe("ncii");
    expect(exclusionOf(kase({ ruleRef: "safety.minors@1" }), NOW)).toBe("minor_safety");
    expect(exclusionOf(report({ reportReason: "ncii", ruleRef: reportRuleRef("ncii") }), NOW)).toBe("ncii");
    expect(exclusionOf(report({ reportReason: "minor_safety", ruleRef: reportRuleRef("minor_safety") }), NOW)).toBe(
      "minor_safety",
    );
    // A clause with no version separator is still read as its id.
    expect(exclusionOf(kase({ ruleRef: null }), NOW)).toBeNull();
  });

  test("watch-room reports are never sampled", () => {
    expect(exclusionOf(report({ reportSubjectType: "watch_room" }), NOW)).toBe("watch_room");
  });

  test("an active legal hold excludes", () => {
    expect(exclusionOf(kase({ legalHold: true }), NOW)).toBe("legal_hold");
    expect(exclusionOf(report({ legalHold: true }), NOW)).toBe("legal_hold");
  });

  test("a minor, an unknown age or an unnamed party excludes (subject or reporter)", () => {
    expect(exclusionOf(kase({ parties: [ADULT, { userId: "m", birthDate: "2012-05-01" }] }), NOW)).toBe("minor");
    expect(exclusionOf(report({ parties: [{ userId: "reporter", birthDate: "2010-01-01" }] }), NOW)).toBe("minor");
    expect(exclusionOf(kase({ parties: [{ userId: "x", birthDate: null }] }), NOW)).toBe("minor");
    expect(exclusionOf(report({ partiesUnknown: true }), NOW)).toBe("unknown_party");
    expect(exclusionOf(kase({ parties: [] }), NOW)).toBeNull();
  });

  test("the 30-day window includes both edges", () => {
    const { from, to } = sampleWindow(NOW);
    expect(to).toEqual(NOW);
    expect(NOW.getTime() - from.getTime()).toBe(JURY_RULES.sampleDays * DAY);
    expect(inSampleWindow(from, NOW)).toBe(true);
    expect(inSampleWindow(new Date(from.getTime() - 1), NOW)).toBe(false);
    expect(inSampleWindow(NOW, NOW)).toBe(true);
    expect(inSampleWindow(new Date(NOW.getTime() + 1), NOW)).toBe(false);
    expect(exclusionOf(kase({ closedAt: new Date(from.getTime() - 1) }), NOW)).toBe("window");
    expect(exclusionOf(kase({ closedAt: from }), NOW)).toBeNull();
  });

  test("candidate entries are the eligible keys, sorted and unique", () => {
    const entries = candidateEntries(
      [
        report({ id: "b" }),
        kase({ id: "z" }),
        kase({ id: "a", tier: "t0" }),
        kase({ id: "z" }),
        kase({ id: "m", legalHold: true }),
      ],
      NOW,
    );
    expect(entries).toEqual(["moderation_case:z", "report:b"]);
    expect(parseCandidateKey(candidateKey(kase({ id: "q" })))).toEqual({ kind: "moderation_case", id: "q" });
    expect(() => parseCandidateKey("vod:1")).toThrow("not a jury candidate key");
  });
});

describe("the minor rule (birth_date, as commonair_age_band)", () => {
  test("18 on the day, not the day before; unknown or invalid is never adult", () => {
    expect(isKnownAdult("2008-11-15", NOW)).toBe(true);
    expect(isKnownAdult("2008-11-16", NOW)).toBe(false);
    expect(isKnownAdult(null, NOW)).toBe(false);
    expect(isKnownAdult("not-a-date", NOW)).toBe(false);
    expect(isKnownAdult("1899-12-31", NOW)).toBe(false);
    expect(isKnownAdult("2030-01-01", NOW)).toBe(false);
  });

  test("a 29 February birthday turns 18 on 1 March of a common year", () => {
    expect(isKnownAdult("2008-02-29", new Date("2026-02-28T23:00:00Z"))).toBe(false);
    expect(isKnownAdult("2008-02-29", new Date("2026-03-01T00:00:00Z"))).toBe(true);
  });

  test("the seat pool keeps adults, sorted by id", () => {
    expect(
      poolEntries(
        [
          { userId: "c", birthDate: "1990-01-01" },
          { userId: "a", birthDate: "1980-01-01" },
          { userId: "b", birthDate: "2012-01-01" },
          { userId: "d", birthDate: null },
          { userId: "a", birthDate: "1980-01-01" },
        ],
        NOW,
      ),
    ).toEqual(["a", "c"]);
  });
});

describe("pseudonyms", () => {
  test("stable within a panel, different across panels", async () => {
    const salt = newSalt();
    const a = await panelPseudonyms(salt, ["u1", "u2", "u1"]);
    const again = await panelPseudonyms(salt, ["u2", "u1"]);
    expect(a.size).toBe(2);
    expect(again.get("u1")).toBe(a.get("u1"));
    expect(a.get("u1")).not.toBe(a.get("u2"));
    expect(a.get("u1")).toMatch(/^[0-9A-F]{8}$/);
    const other = await panelPseudonyms(newSalt(), ["u1"]);
    expect(other.get("u1")).not.toBe(a.get("u1"));
  });

  test("a case map names the subject and the shown parties, never anyone else", async () => {
    const names = await panelPseudonyms(newSalt(), ["subj", "owner", "reporter"]);
    const map = caseMap(names, "subj", ["subj", "owner"]);
    expect(map[SUBJECT_KEY]).toBe(names.get("subj"));
    expect(Object.keys(map).sort()).toEqual(["owner", "subj", SUBJECT_KEY].sort());
    expect(Object.values(map)).not.toContain(names.get("reporter"));
  });
});

describe("majority disagree", () => {
  const counts = (agree: number, disagree: number, unsure: number) => ({ agree, disagree, unsure });
  test("more than half of the votes cast", () => {
    expect(majorityDisagrees(counts(1, 4, 2))).toBe(true);
    expect(majorityDisagrees(counts(0, 1, 0))).toBe(true);
  });
  test("a tie is not a majority", () => {
    expect(majorityDisagrees(counts(3, 3, 0))).toBe(false);
  });
  test("an even split with unsure is not a majority, and unsure counts as cast", () => {
    expect(majorityDisagrees(counts(2, 3, 1))).toBe(false);
    expect(majorityDisagrees(counts(0, 2, 2))).toBe(false);
    expect(majorityDisagrees(counts(0, 0, 0))).toBe(false);
  });
  test("counting", () => {
    expect(countVotes([{ vote: "agree" }, { vote: "disagree" }, { vote: "disagree" }, { vote: "unsure" }])).toEqual(
      counts(1, 2, 1),
    );
  });
});

describe("settings and the draw", () => {
  test("missing or malformed settings read as off with the defaults", () => {
    expect(parseJurySettings([])).toEqual({
      enabled: false,
      panelSize: JURY_RULES.panelSize,
      casesPerPanel: JURY_RULES.casesPerPanel,
    });
    expect(
      parseJurySettings([
        { key: "jury.enabled", value: { enabled: true } },
        { key: "jury.panelSize", value: { panelSize: 2 } },
        { key: "jury.casesPerPanel", value: { casesPerPanel: 5 } },
      ]),
    ).toEqual({ enabled: true, panelSize: JURY_RULES.panelSize, casesPerPanel: 5 });
  });

  test("same seed and pool give the same seats and cases; another seed differs", async () => {
    const pool = Array.from({ length: 30 }, (_, i) => `u${String(i).padStart(2, "0")}`);
    const cases = Array.from({ length: 60 }, (_, i) => `report:${String(i).padStart(3, "0")}`);
    const seed = newSeed();
    const a = await selectPanel(seed, pool, cases, { panelSize: 7, casesPerPanel: 20 });
    const b = await selectPanel(seed, pool, cases, { panelSize: 7, casesPerPanel: 20 });
    expect(b).toEqual(a);
    expect(a.seats).toHaveLength(7);
    expect([...a.seats].sort()).toEqual(a.seats);
    expect(new Set(a.cases).size).toBe(20);
    const c = await selectPanel(newSeed(), pool, cases, { panelSize: 7, casesPerPanel: 20 });
    expect(c.seats.join() === a.seats.join() && c.cases.join() === a.cases.join()).toBe(false);
    // A small pool seats everyone.
    expect((await selectPanel(seed, ["x", "y"], [], { panelSize: 7, casesPerPanel: 20 })).seats).toEqual(["x", "y"]);
    expect(await verifyReveal(seed, await commit(seed))).toBe(true);
  });

  test("the panel period is the UTC month", () => {
    expect(panelPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
    expect(panelPeriod(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01");
  });
});
