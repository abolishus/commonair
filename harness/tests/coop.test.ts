// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The e5-coop scenario's pure parts: step prefixes, the bootstrap settings and the compose
 * override (alone and layered with the trust-safety one), the proposal changes, the expected tally
 * per class, the patronage period, audit/outbox matching, the ballot and personal-data scans, the
 * E5 selectors against the spec, and the test-hook client against a fake API.
 */
import { DEFAULT_GOVERNANCE_SETTINGS } from "@commonair/db";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { E5_ROUTE_PATTERNS, E5_ROUTES, E5_TEMPLATED_IDS, E5_TEST_IDS, ctid } from "../src/coop-selectors.ts";
import { CoopHooks, CoopHooksOff, isSkipped } from "../src/coop-io.ts";
import {
  ALL_COOP_STEPS,
  API_PERIOD_UNIT_MS,
  WEB_PERIOD_UNIT_MS,
  type AuditRow,
  type CastVote,
  type ComposeFile,
  E5_GOVERNANCE_BOOTSTRAP,
  MAX_DISCUSSION_SECONDS,
  MEMBERSHIP_CLASSES_DEFAULTS,
  STREAMER_MAJORITY_NOT_MET,
  auditMatches,
  ceilTo,
  choosePatronagePeriod,
  councilSeatingProblem,
  councilSize,
  DEFAULT_COUNCIL_SIZE,
  commentText,
  cutChange,
  datetimeLocalUtc,
  eventMatches,
  expectedTally,
  floorTo,
  governancePeriods,
  layerComposeEnv,
  leaksIn,
  missed,
  missingAudit,
  heldQualifyingSubscription,
  minSubscriptionCents,
  missingEvents,
  nextSpotlightSlots,
  parseCoopSteps,
  preflightGovernance,
  qualifyingTier,
  rankingChange,
  reached,
  rowLeaks,
  sameValue,
  scanCoopLog,
  shallowMergeSettings,
  summarizeLogLeaks,
  tallyMismatches,
  utcMonthOf,
  viewerState,
} from "../src/coop.ts";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const E5_DOC = readFileSync(root("docs/testing/e5-selectors.md"), "utf8");
const E5_COMPOSE = Bun.YAML.parse(readFileSync(root("harness/compose.e5-coop.yaml"), "utf8")) as ComposeFile;
const TS_COMPOSE = Bun.YAML.parse(readFileSync(root("harness/compose.trust-safety.yaml"), "utf8")) as ComposeFile;

describe("steps", () => {
  test("all, empty and prefixes", () => {
    expect(parseCoopSteps("all")).toEqual([...ALL_COOP_STEPS]);
    expect(parseCoopSteps("")).toEqual([...ALL_COOP_STEPS]);
    expect(parseCoopSteps("1")).toEqual([1]);
    expect(parseCoopSteps("1-5")).toEqual([1, 2, 3, 4, 5]);
    expect(parseCoopSteps(" 1-9 ")).toEqual([...ALL_COOP_STEPS]);
  });

  test("anything that is not a prefix is refused with a hint", () => {
    for (const bad of ["2-5", "3", "1-10", "1-0", "0", "1,2", "x", "1-"]) {
      expect(() => parseCoopSteps(bad)).toThrow(/prefix 1-N/);
    }
  });
});

describe("bootstrap and the compose override", () => {
  const seeded = Object.fromEntries(DEFAULT_GOVERNANCE_SETTINGS.map((s) => [s.key, s.value as unknown]));
  const composeJson = () => {
    const raw = (E5_COMPOSE.services?.migrate?.environment as Record<string, unknown> | undefined)
      ?.GOVERNANCE_BOOTSTRAP_JSON;
    expect(typeof raw).toBe("string");
    return JSON.parse(String(raw)) as unknown;
  };

  test("the override's GOVERNANCE_BOOTSTRAP_JSON is exactly E5_GOVERNANCE_BOOTSTRAP", () => {
    expect(sameValue(composeJson(), E5_GOVERNANCE_BOOTSTRAP)).toBe(true);
  });

  test("the spec's values: short periods, quorum 0.01, a 36-second streamer threshold", () => {
    const b = E5_GOVERNANCE_BOOTSTRAP;
    expect(b["governance.protections"]).toEqual({
      councilReviewSeconds: 30,
      minVotingSeconds: 45,
      quorum: 0.01,
      streamerClassQuorum: 0.01,
    });
    expect(b["governance.ordinary"]).toEqual({
      discussionSeconds: 30,
      minVotingSeconds: 45,
      votingSeconds: 45,
      quorum: 0.01,
    });
    expect(b["membership.classes"].streamer.minStreamingHours * 3600).toBeCloseTo(36);
    expect(b["council.config"]).toEqual({ size: 50, minStreamingHours: 0.01 });
  });

  test("membership.classes carries every class whole, with the seeded defaults", () => {
    expect(sameValue(seeded["membership.classes"], MEMBERSHIP_CLASSES_DEFAULTS)).toBe(true);
    const merged = shallowMergeSettings(seeded, E5_GOVERNANCE_BOOTSTRAP) as Record<string, Record<string, unknown>>;
    const classes = merged["membership.classes"] as typeof MEMBERSHIP_CLASSES_DEFAULTS;
    expect(classes.viewer).toEqual(MEMBERSHIP_CLASSES_DEFAULTS.viewer);
    expect(classes.worker).toEqual(MEMBERSHIP_CLASSES_DEFAULTS.worker);
    expect(classes.streamer).toEqual({ ...MEMBERSHIP_CLASSES_DEFAULTS.streamer, minStreamingHours: 0.01 });
  });

  test("the merged settings keep the rest of each default and stay valid", () => {
    const merged = shallowMergeSettings(seeded, E5_GOVERNANCE_BOOTSTRAP) as Record<string, Record<string, number>>;
    const ordinary = merged["governance.ordinary"] as Record<string, number>;
    expect(ordinary.threshold).toBe(0.5);
    expect(ordinary.votingSeconds).toBeGreaterThanOrEqual(ordinary.minVotingSeconds as number);
    const protections = merged["governance.protections"] as Record<string, unknown>;
    expect(protections.memberWideThreshold).toBeCloseTo(2 / 3);
    expect(protections.protectedKeys).toContain("platform.cut");
    expect((merged["council.config"] as Record<string, unknown>).size).toBe(50);
    // Keys the override does not name are untouched.
    expect(merged["discovery.ranking"]).toBe(seeded["discovery.ranking"]);
    expect(preflightGovernance(Object.entries(merged).map(([key, value]) => ({ key, value }))).ok).toBe(true);
  });

  test("COOP_TEST_HOOKS for api and worker only; the bootstrap for migrate only", () => {
    const { env, conflicts, notMappings } = layerComposeEnv([E5_COMPOSE]);
    expect(conflicts).toEqual([]);
    expect(notMappings).toEqual([]);
    expect(env.api).toEqual({ COOP_TEST_HOOKS: "true" });
    expect(env.worker).toEqual({ COOP_TEST_HOOKS: "true" });
    expect(Object.keys(env.migrate ?? {})).toEqual(["GOVERNANCE_BOOTSTRAP_JSON"]);
    expect(Object.keys(env).sort()).toEqual(["api", "migrate", "worker"]);
  });

  test("layers cleanly with the trust-safety override (either order)", () => {
    for (const files of [
      [TS_COMPOSE, E5_COMPOSE],
      [E5_COMPOSE, TS_COMPOSE],
    ]) {
      const { env, conflicts, notMappings } = layerComposeEnv(files);
      expect(conflicts).toEqual([]);
      expect(notMappings).toEqual([]);
      for (const svc of ["api", "worker"]) {
        expect(env[svc]?.COOP_TEST_HOOKS).toBe("true");
        expect(env[svc]?.MODERATION_TEST_HOOKS).toBe("true");
      }
      expect(env.media?.MODERATION_CLASSIFIER).toBe("scripted");
      expect(env.media?.COOP_TEST_HOOKS).toBeUndefined();
      expect(env.migrate?.GOVERNANCE_BOOTSTRAP_JSON).toBeDefined();
    }
    // The e5 override adds no volumes, so the trust-safety fixture mounts are not replaced.
    for (const def of Object.values(E5_COMPOSE.services ?? {})) expect(def?.volumes).toBeUndefined();
  });

  test("layering reports conflicts and list-form environments", () => {
    const r = layerComposeEnv([
      { services: { api: { environment: { A: "1" } } } },
      { services: { api: { environment: { A: "2", B: 3 } }, worker: { environment: ["X=1"] } } },
    ]);
    expect(r.conflicts).toEqual([{ service: "api", key: "A" }]);
    expect(r.notMappings).toEqual([{ file: 1, service: "worker" }]);
    expect(r.env.api).toEqual({ A: "2", B: "3" });
  });
});

describe("preflight and periods", () => {
  const settings = (discussionSeconds: unknown) => [
    { key: "governance.ordinary", value: { discussionSeconds, votingSeconds: 45, minVotingSeconds: 45 } },
    { key: "governance.protections", value: { councilReviewSeconds: 30, minVotingSeconds: 60 } },
  ];

  test("discussion ≤ 60 s passes; longer or missing fails with the reset hint", () => {
    expect(preflightGovernance(settings(30))).toEqual({ ok: true, problem: null });
    expect(preflightGovernance(settings(MAX_DISCUSSION_SECONDS)).ok).toBe(true);
    const long = preflightGovernance(settings(14 * 86_400));
    expect(long.ok).toBe(false);
    expect(long.problem).toMatch(/1209600 \(> 60\)/);
    expect(long.problem).toMatch(/compose\.e5-coop\.yaml/);
    expect(long.problem).toMatch(/ADR 0020/);
    expect(preflightGovernance([]).ok).toBe(false);
    expect(preflightGovernance(settings("30")).problem).toMatch(/missing/);
  });

  test("governancePeriods: protected voting is raised to minVotingSeconds", () => {
    expect(governancePeriods(settings(30))).toEqual({
      discussionSeconds: 30,
      councilReviewSeconds: 30,
      votingSeconds: 45,
      protectedVotingSeconds: 60,
    });
    expect(governancePeriods([])).toEqual({
      discussionSeconds: 30,
      councilReviewSeconds: 30,
      votingSeconds: 45,
      protectedVotingSeconds: 45,
    });
  });
});

describe("proposal changes", () => {
  const ranking = {
    spotlightSlots: 4,
    spotlightMaxViewers: 10,
    spotlightRotationMinutes: 10,
    newChannelMaxAgeDays: 30,
    weights: { viewers: 0.4, freshness: 0.2, followMomentum: 0.2, smallChannelBoost: 0.2 },
  };

  test("spotlightSlots alternates 4/5 across runs", () => {
    expect(nextSpotlightSlots(4)).toBe(5);
    expect(nextSpotlightSlots(5)).toBe(4);
    expect(nextSpotlightSlots(7)).toBe(4);
    expect(nextSpotlightSlots(undefined)).toBe(4);
  });

  test("the ranking change sends the whole value with only spotlightSlots replaced", () => {
    const c = rankingChange(ranking);
    expect(c.key).toBe("discovery.ranking");
    expect(c.value).toEqual({ ...ranking, spotlightSlots: 5 });
    expect(rankingChange(c.value).value.spotlightSlots).toBe(4);
    expect(ranking.spotlightSlots).toBe(4);
    expect(() => rankingChange(null)).toThrow(/discovery\.ranking/);
    expect(() => rankingChange([1])).toThrow(/discovery\.ranking/);
  });

  test("the cut change is streamer 0.85, co-op exactly 0.15, whole value", () => {
    const c = cutChange({ streamerShare: 0.9, coopShare: 0.1 });
    expect(c).toEqual({ key: "platform.cut", value: { streamerShare: 0.85, coopShare: 0.15 } });
    expect(cutChange({ streamerShare: 0.9, coopShare: 0.1 }, 0.7).value.coopShare).toBe(0.3);
    expect(() => cutChange(undefined)).toThrow(/platform\.cut/);
  });

  test("sameValue compares JSON structurally", () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue(0.85, 0.85)).toBe(true);
    expect(sameValue({ a: [] }, { a: {} })).toBe(false);
  });
});

describe("proposal status", () => {
  test("reached follows the lifecycle and its decided branches", () => {
    expect(reached("discussion", "discussion")).toBe(true);
    expect(reached("council_review", "discussion")).toBe(true);
    expect(reached("voting", "council_review")).toBe(true);
    expect(reached("discussion", "voting")).toBe(false);
    expect(reached("applied", "passed")).toBe(true);
    expect(reached("passed", "passed")).toBe(true);
    expect(reached("rejected", "passed")).toBe(false);
    expect(reached("rejected", "voting")).toBe(true);
    expect(reached("applied", "rejected")).toBe(false);
    expect(reached("passed", "applied")).toBe(false);
    expect(reached("withdrawn", "discussion")).toBe(false);
    expect(reached("unknown", "draft")).toBe(false);
  });

  test("missed: moved past a status the scenario had to act in", () => {
    expect(missed("council_review", "council_review")).toBe(false);
    expect(missed("discussion", "council_review")).toBe(false);
    expect(missed("voting", "council_review")).toBe(true);
    expect(missed("rejected", "voting")).toBe(true);
    expect(missed("withdrawn", "voting")).toBe(false);
  });
});

describe("expected tally", () => {
  const A: CastVote[] = [
    { classes: ["viewer"], choice: "yes" },
    { classes: ["worker"], choice: "yes" },
    { classes: ["streamer"], choice: "yes" },
    { classes: ["streamer"], choice: "yes" },
  ];
  const B: CastVote[] = [
    { classes: ["viewer"], choice: "yes" },
    { classes: ["worker"], choice: "yes" },
    { classes: ["streamer"], choice: "yes" },
    { classes: ["streamer"], choice: "no" },
  ];

  test("the ordinary proposal: streamer 2 yes, viewer 1, worker 1", () => {
    const e = expectedTally(A);
    expect(e.memberWide).toEqual({ yes: 4, no: 0, abstain: 0 });
    expect(e.byClass.streamer).toEqual({ yes: 2, no: 0, abstain: 0 });
    expect(e.byClass.viewer).toEqual({ yes: 1, no: 0, abstain: 0 });
    expect(e.byClass.worker).toEqual({ yes: 1, no: 0, abstain: 0 });
  });

  test("the protected proposal: 3/4 member-wide, 1/2 in the streamer class", () => {
    const e = expectedTally(B);
    expect(e.memberWide).toEqual({ yes: 3, no: 1, abstain: 0 });
    expect(e.memberWide.yes / (e.memberWide.yes + e.memberWide.no)).toBeGreaterThanOrEqual(2 / 3);
    expect(e.byClass.streamer).toEqual({ yes: 1, no: 1, abstain: 0 });
    // Not a strict majority: the reason the database records.
    expect(e.byClass.streamer.yes / (e.byClass.streamer.yes + e.byClass.streamer.no) > 0.5).toBe(false);
    expect(STREAMER_MAJORITY_NOT_MET).toBe("streamer-class majority not met");
  });

  test("a member in several classes counts once per class; duplicates do not double count", () => {
    const e = expectedTally([{ classes: ["streamer", "viewer", "streamer"], choice: "abstain" }]);
    expect(e.memberWide.abstain).toBe(1);
    expect(e.byClass.streamer.abstain).toBe(1);
    expect(e.byClass.viewer.abstain).toBe(1);
    expect(e.byClass.worker).toEqual({ yes: 0, no: 0, abstain: 0 });
    expect(expectedTally([]).memberWide).toEqual({ yes: 0, no: 0, abstain: 0 });
  });

  test("counts must match exactly; the electorate may be larger than the voters", () => {
    const e = expectedTally(B);
    const observed = {
      memberWide: { yes: 3, no: 1, abstain: 0, eligible: 9 },
      byClass: {
        streamer: { yes: 1, no: 1, abstain: 0, eligible: 2 },
        viewer: { yes: 1, no: 0, abstain: 0, eligible: 5 },
        worker: { yes: 1, no: 0, abstain: 0, eligible: 1 },
      },
    };
    expect(tallyMismatches(e, observed)).toEqual([]);
    const wrong = tallyMismatches(e, {
      memberWide: { ...observed.memberWide, eligible: 3 },
      byClass: { ...observed.byClass, streamer: { yes: 2, no: 0, abstain: 0, eligible: 2 }, worker: undefined },
    });
    expect(wrong).toContainEqual({ scope: "member_wide", field: "eligible", expected: 4, observed: 3 });
    expect(wrong).toContainEqual({ scope: "streamer", field: "yes", expected: 1, observed: 2 });
    expect(wrong).toContainEqual({ scope: "streamer", field: "no", expected: 1, observed: 0 });
    expect(wrong).toContainEqual({ scope: "worker", field: "yes", expected: 1, observed: null });
    expect(wrong).toContainEqual({ scope: "worker", field: "eligible", expected: 1, observed: null });
  });
});

describe("patronage period", () => {
  const start = new Date("2026-10-21T10:00:00.400Z");
  const now = new Date("2026-10-21T10:20:00.900Z");

  test("[run start, now − 1 s) in whole seconds (API)", () => {
    expect(choosePatronagePeriod(start, now, [])).toEqual({
      start: new Date("2026-10-21T10:00:01.000Z"),
      end: new Date("2026-10-21T10:19:59.000Z"),
    });
    expect(ceilTo(new Date("2026-10-21T10:00:00.000Z")).toISOString()).toBe("2026-10-21T10:00:00.000Z");
    expect(floorTo(new Date("2026-10-21T10:00:00.999Z")).toISOString()).toBe("2026-10-21T10:00:00.000Z");
  });

  test("rounded inward to whole minutes for the web form", () => {
    expect(choosePatronagePeriod(start, now, [], WEB_PERIOD_UNIT_MS)).toEqual({
      start: new Date("2026-10-21T10:01:00.000Z"),
      end: new Date("2026-10-21T10:19:00.000Z"),
    });
    expect(choosePatronagePeriod(start, new Date("2026-10-21T10:01:30.000Z"), [], WEB_PERIOD_UNIT_MS)).toBeNull();
    expect(API_PERIOD_UNIT_MS).toBe(1_000);
  });

  test("starts after any earlier period that ends after the run started", () => {
    const p = choosePatronagePeriod(start, now, [
      { periodEnd: "2026-10-21T10:05:00.000Z" },
      { periodEnd: "2026-10-20T00:00:00.000Z" },
      { periodEnd: "not a date" },
    ]);
    expect(p?.start.toISOString()).toBe("2026-10-21T10:05:00.000Z");
  });

  test("null when nothing is left", () => {
    expect(choosePatronagePeriod(start, new Date("2026-10-21T10:00:01.500Z"), [])).toBeNull();
    expect(choosePatronagePeriod(start, now, [{ periodEnd: "2026-10-21T11:00:00.000Z" }])).toBeNull();
  });

  test("datetime-local values are UTC with seconds; months are UTC", () => {
    expect(datetimeLocalUtc(new Date("2026-10-21T09:05:03.000Z"))).toBe("2026-10-21T09:05:03");
    expect(datetimeLocalUtc(new Date("2026-10-21T09:05:00.000Z"))).toBe("2026-10-21T09:05");
    expect(utcMonthOf("2026-10-31T23:59:59.000Z")).toBe("2026-10");
    expect(utcMonthOf(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11");
  });
});

describe("audit and outbox expectations", () => {
  const P = "0190aaaa-0000-7000-8000-000000000001";
  const U = "0190bbbb-0000-7000-8000-000000000002";
  const row = (over: Partial<AuditRow>): AuditRow => ({
    action: "proposal.vote",
    actorType: "user",
    actorId: U,
    subjectType: "proposal",
    subjectId: P,
    details: { proposalId: P },
    ...over,
  });

  test("an audit row matches by action, actor type, actor and a mentioned id", () => {
    const e = { action: "proposal.vote", actorType: "user", actorId: U, mentions: P, label: "vote" };
    expect(auditMatches(row({}), e)).toBe(true);
    expect(auditMatches(row({ subjectId: "x", details: { nested: { id: P } } }), e)).toBe(true);
    expect(auditMatches(row({ actorType: "admin" }), e)).toBe(false);
    expect(auditMatches(row({ actorId: "other" }), e)).toBe(false);
    expect(auditMatches(row({ subjectId: "x", details: {} }), e)).toBe(false);
    expect(
      auditMatches(row({ actorId: null, actorType: "system" }), { ...e, actorType: "system", actorId: null }),
    ).toBe(true);
    expect(missingAudit([e, { ...e, action: "proposal.decide" }], [row({})]).map((m) => m.action)).toEqual([
      "proposal.decide",
    ]);
  });

  test("an event matches by type, a mentioned id and payload fields", () => {
    const ev = { type: "coop.proposal.update", payload: { proposal_id: P, status: "discussion" } };
    expect(eventMatches(ev, { type: "coop.proposal.update", mentions: P, label: "x" })).toBe(true);
    expect(
      eventMatches(ev, { type: "coop.proposal.update", mentions: P, where: { status: "discussion" }, label: "x" }),
    ).toBe(true);
    expect(
      eventMatches(ev, { type: "coop.proposal.update", mentions: P, where: { status: "voting" }, label: "x" }),
    ).toBe(false);
    expect(eventMatches(ev, { type: "coop.vote.cast", mentions: P, label: "x" })).toBe(false);
    expect(
      eventMatches({ type: "coop.vote.cast", payload: null }, { type: "coop.vote.cast", mentions: P, label: "x" }),
    ).toBe(false);
    expect(missingEvents([{ type: "coop.vote.cast", mentions: P, label: "votes" }], [ev]).map((m) => m.label)).toEqual([
      "votes",
    ]);
  });
});

describe("ballot secrecy and personal data", () => {
  const opts = { commentBodies: [commentText("run1", "V")], emails: ["v@harness.test"] };

  test("a ballot row holds no choice at all", () => {
    expect(leaksIn("audit:proposal.vote", { proposalId: "p" }, { ...opts, ballot: true })).toEqual([]);
    expect(leaksIn("audit:proposal.vote", { proposalId: "p", c: "Yes" }, { ...opts, ballot: true })).toEqual([
      { source: "audit:proposal.vote", kind: "vote-choice" },
    ]);
    expect(leaksIn("event:coop.vote.cast", { proposal_id: "p", x: ["no"] }, { ...opts, ballot: true })).toHaveLength(1);
  });

  test("a choice key with a choice value leaks anywhere; other strings do not", () => {
    expect(leaksIn("audit:proposal.decide", { passed: true, rule: "passed" }, { ...opts, ballot: false })).toEqual([]);
    expect(leaksIn("audit:council.respond", { stance: "oppose" }, { ...opts, ballot: false })).toEqual([]);
    expect(leaksIn("audit:x", { reason: "no" }, { ...opts, ballot: false })).toEqual([]);
    expect(leaksIn("audit:x", { user: "u", choice: "no" }, { ...opts, ballot: false })).toEqual([
      { source: "audit:x", kind: "vote-choice" },
    ]);
    expect(leaksIn("event:x", { nested: { myVote: "abstain" } }, { ...opts, ballot: false })).toHaveLength(1);
  });

  test("comment bodies and emails are leaks", () => {
    expect(leaksIn("audit:proposal.comment", { body: commentText("run1", "V") }, { ...opts, ballot: false })).toEqual([
      { source: "audit:proposal.comment", kind: "comment-body" },
    ]);
    expect(leaksIn("event:x", { to: "V@Harness.test" }, { ...opts, ballot: false })).toEqual([
      { source: "event:x", kind: "email" },
    ]);
  });

  test("rowLeaks groups by source and kind and judges ballots by action or type", () => {
    const leaks = rowLeaks(
      [
        {
          action: "proposal.vote",
          actorType: "user",
          actorId: "u",
          subjectType: "proposal",
          subjectId: "p",
          details: { c: "yes" },
        },
        {
          action: "proposal.vote",
          actorType: "user",
          actorId: "u",
          subjectType: "proposal",
          subjectId: "p",
          details: { c: "no" },
        },
        {
          action: "proposal.decide",
          actorType: "system",
          actorId: null,
          subjectType: "proposal",
          subjectId: "p",
          details: { rule: "no" },
        },
      ],
      [
        { type: "coop.vote.cast", payload: { proposal_id: "p" } },
        { type: "coop.proposal.comment", payload: { body: commentText("run1", "V") } },
      ],
      opts,
    );
    expect(leaks).toEqual([
      { source: "audit:proposal.vote", kind: "vote-choice" },
      { source: "event:coop.proposal.comment", kind: "comment-body" },
    ]);
  });

  test("service logs: a choice field, a voter next to a quoted choice, comments and emails", () => {
    const needles = { voters: ["0190-voter-id", "e5_s1_ab"], ...opts };
    const log = [
      '{"level":"info","msg":"vote cast","proposalId":"p"}',
      '{"level":"info","msg":"vote","choice":"yes"}',
      "vote=no for proposal p",
      '{"msg":"x","user":"e5_s1_ab","value":"abstain"}',
      '{"msg":"no voter here","value":"no"}',
      `comment: ${commentText("run1", "V")}`,
      "mail sent to v@harness.test",
      "",
      "there is no problem",
    ].join("\n");
    const leaks = scanCoopLog("api", log, needles);
    expect(leaks).toEqual([
      { source: "api", line: 2, kind: "vote-choice" },
      { source: "api", line: 3, kind: "vote-choice" },
      { source: "api", line: 4, kind: "vote-choice" },
      { source: "api", line: 6, kind: "comment-body" },
      { source: "api", line: 7, kind: "email" },
    ]);
    expect(summarizeLogLeaks(leaks)).toEqual([
      { source: "api", kind: "comment-body", count: 1 },
      { source: "api", kind: "email", count: 1 },
      { source: "api", kind: "vote-choice", count: 3 },
    ]);
  });

  test("short needles are ignored (no false hits on two-letter ids)", () => {
    expect(scanCoopLog("api", '"ab" "yes"', { voters: ["ab"], commentBodies: ["short"], emails: ["nope"] })).toEqual(
      [],
    );
  });

  test("comment text is run-unique", () => {
    expect(commentText("r1", "V")).not.toBe(commentText("r2", "V"));
    expect(commentText("r1", "V")).not.toBe(commentText("r1", "W"));
  });
});

describe("E5 selectors match docs/testing/e5-selectors.md", () => {
  const section = (heading: string) => {
    const lines = E5_DOC.split("\n");
    const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
    if (start < 0) throw new Error(`no "## ${heading}" section`);
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  };
  const spans = (text: string) => new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));

  test("every test id the scenario uses is in the spec's Test ids section", () => {
    const ids = spans(section("Test ids"));
    for (const id of Object.values(E5_TEST_IDS)) expect(ids.has(id), id).toBe(true);
    expect(ids.has("membership-exit-<class>")).toBe(true);
    expect(ids.has("proposal-change-key-<key>")).toBe(true);
    for (const c of ["yes", "no", "abstain"]) expect(ids.has(E5_TEMPLATED_IDS.voteChoiceItem(c))).toBe(true);
    expect(E5_TEMPLATED_IDS.membershipExit("viewer")).toBe("membership-exit-viewer");
    expect(E5_TEMPLATED_IDS.proposalChangeKeyItem("discovery.ranking")).toBe("proposal-change-key-discovery.ranking");
  });

  test("the route patterns are the spec's Routes table", () => {
    const routes = section("Routes")
      .split("\n")
      .map((l) => /^\|\s*`([^`]+)`\s*\|/.exec(l)?.[1])
      .filter((x): x is string => x !== undefined);
    expect(routes).toEqual([...E5_ROUTE_PATTERNS]);
    expect(E5_ROUTES.proposal("a b")).toBe("/coop/proposals/a%20b");
    expect(E5_ROUTES.statement("p")).toBe("/coop/patronage/p");
  });

  test("ctid builds attribute selectors with escaping", () => {
    expect(ctid("tally-row", { scope: "streamer" })).toBe('[data-testid="tally-row"][data-scope="streamer"]');
    expect(ctid("x", { a: 'q"z' })).toBe('[data-testid="x"][data-a="q\\"z"]');
  });
});

describe("the co-op test hook client", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { job: string; secret: string | null }[] = [];
  let skipFirst = 0;
  let status = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== INTERNAL_ROUTES.coopTick || req.method !== "POST")
          return new Response(null, { status: 404 });
        if (status !== 200) return new Response(null, { status });
        const body = (await req.json()) as { job: string };
        seen.push({ job: body.job, secret: req.headers.get(INTERNAL_SECRET_HEADER) });
        if (skipFirst > 0) {
          skipFirst--;
          return Response.json({ skipped: 1 });
        }
        return Response.json({ advanced: 1 });
      },
    });
  });
  afterAll(() => server.stop(true));

  const hooks = () => new CoopHooks(`http://localhost:${server.port}`, "s3cret");

  test("tick posts the job with the internal secret and returns the counts", async () => {
    status = 200;
    seen.length = 0;
    const h = hooks();
    expect(await h.tick("proposals-advance")).toEqual({ advanced: 1 });
    expect(seen).toEqual([{ job: "proposals-advance", secret: "s3cret" }]);
    expect(h.ticks).toHaveLength(1);
    expect(h.ticks[0]?.job).toBe("proposals-advance");
  });

  test("tickRan repeats a skipped tick until the job runs", async () => {
    status = 200;
    seen.length = 0;
    skipFirst = 2;
    const r = await hooks().tickRan("membership-sync", 5, 1);
    expect(r).toEqual({ advanced: 1 });
    expect(seen).toHaveLength(3);
    expect(isSkipped({ skipped: 1 })).toBe(true);
    expect(isSkipped({ advanced: 2 })).toBe(false);
    skipFirst = 5;
    await expect(hooks().tickRan("membership-sync", 2, 1)).rejects.toThrow(/run lock stayed busy/);
    skipFirst = 0;
  });

  test("404 means the hooks are off; other errors name the status", async () => {
    status = 404;
    await expect(hooks().tick("council-recompute")).rejects.toBeInstanceOf(CoopHooksOff);
    await expect(hooks().tick("council-recompute")).rejects.toThrow(/compose\.e5-coop\.yaml/);
    status = 504;
    const h = hooks();
    await expect(h.tick("council-recompute")).rejects.toThrow(/HTTP 504/);
    expect(h.ticks[0]?.error).toBe("Error");
    status = 200;
  });

  test("tickUntil waits on state, ticking in between, and times out with what it waited for", async () => {
    status = 200;
    seen.length = 0;
    let reads = 0;
    const v = await hooks().tickUntil("proposals-advance", "three reads", async () => (++reads >= 3 ? "done" : null), {
      timeoutMs: 5_000,
      intervalMs: 1,
    });
    expect(v).toBe("done");
    expect(seen.length).toBeGreaterThanOrEqual(1);
    await expect(
      hooks().tickUntil("proposals-advance", "never", async () => null, { timeoutMs: 1, intervalMs: 1 }),
    ).rejects.toThrow(/waiting for never/);
  });

  test("tickUntil keeps waiting through a failed tick, but not when the hooks are off", async () => {
    status = 504;
    let reads = 0;
    const v = await hooks().tickUntil("proposals-advance", "x", async () => (++reads >= 4 ? 1 : null), {
      timeoutMs: 5_000,
      intervalMs: 1,
    });
    expect(v).toBe(1);
    status = 404;
    await expect(
      hooks().tickUntil("proposals-advance", "x", async () => null, { timeoutMs: 5_000, intervalMs: 1 }),
    ).rejects.toBeInstanceOf(CoopHooksOff);
    status = 200;
  });
});

describe("council seating outlook (step 2 on a long-lived stack)", () => {
  const wanted = ["s1", "s2"];
  const others = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);

  test("council.config.size falls back to the seed default", () => {
    expect(councilSize([])).toBe(DEFAULT_COUNCIL_SIZE);
    expect(councilSize([{ key: "council.config", value: { minStreamingHours: 0.01 } }])).toBe(7);
    expect(councilSize([{ key: "council.config", value: { size: 50 } }])).toBe(50);
    expect(councilSize([{ key: "council.config", value: { size: 0 } }])).toBe(7);
  });

  test("a fresh stack seats S1 and S2", () => {
    expect(councilSeatingProblem({ size: 7, activeStreamers: wanted, seated: [], wanted })).toBeNull();
  });

  test("already seated is fine whatever the competition", () => {
    expect(
      councilSeatingProblem({ size: 7, activeStreamers: [...wanted, ...others(10)], seated: wanted, wanted }),
    ).toBeNull();
  });

  test("at most size candidates: an unfilled term or a vacancy reseats everyone", () => {
    expect(
      councilSeatingProblem({ size: 7, activeStreamers: [...wanted, ...others(5)], seated: others(5), wanted }),
    ).toBeNull();
    // A previous run's exited streamers still hold seats: a vacancy.
    expect(
      councilSeatingProblem({
        size: 7,
        activeStreamers: [...wanted, ...others(5)],
        seated: ["old1", "old2", ...others(5)],
        wanted,
      }),
    ).toBeNull();
  });

  test("a full term without a vacancy stands for the month", () => {
    const problem = councilSeatingProblem({
      size: 7,
      activeStreamers: [...wanted, ...others(7)],
      seated: others(7),
      wanted,
    });
    expect(problem).toMatch(/full \(7\/7 seats, no vacancy\)/);
    expect(problem).toMatch(/council\.config\.size/);
  });

  test("more candidates than seats: S1 and S2 are likely outranked even when a reseat is due", () => {
    const problem = councilSeatingProblem({
      size: 7,
      activeStreamers: [...wanted, ...others(7)],
      seated: ["gone", ...others(6)],
      wanted,
    });
    expect(problem).toMatch(/9 active streamer members compete for 7 council seats/);
  });

  test("a streamer that is not an active member can never be seated", () => {
    expect(councilSeatingProblem({ size: 7, activeStreamers: ["s1"], seated: [], wanted })).toMatch(
      /not active streamer members/,
    );
  });
});

describe("rejoin helpers (E7)", () => {
  const tiers = [
    { tier: 1 as const, price: { cents: 299 } },
    { tier: 3 as const, price: { cents: 1999 } },
    { tier: 2 as const, price: { cents: 999 } },
  ];

  test("qualifyingTier: the cheapest tier at or above the minimum", () => {
    expect(qualifyingTier(tiers, 300)).toBe(2);
    expect(qualifyingTier(tiers, 299)).toBe(1);
    expect(qualifyingTier(tiers, 0)).toBe(1);
    expect(qualifyingTier(tiers, 1999)).toBe(3);
    expect(qualifyingTier(tiers, 2000)).toBeNull();
    expect(qualifyingTier([], 0)).toBeNull();
  });

  test("heldQualifyingSubscription: reuses a holding, qualifying subscription to that channel", () => {
    const sub = (over: Partial<{ channelSlug: string; tier: number; status: string }>) => ({
      channelSlug: "s1",
      tier: 2,
      status: "active",
      ...over,
    });
    expect(heldQualifyingSubscription([sub({})], "s1", tiers, 300)).toEqual(sub({}));
    expect(heldQualifyingSubscription([sub({ status: "past_due" })], "s1", tiers, 300)).not.toBeNull();
    // Pending, ended, another channel, a tier below the minimum or unknown: not reusable.
    for (const s of [
      sub({ status: "incomplete" }),
      sub({ status: "canceled" }),
      sub({ status: "expired" }),
      sub({ channelSlug: "s2" }),
      sub({ tier: 1 }),
      sub({ tier: 9 }),
    ])
      expect(heldQualifyingSubscription([s], "s1", tiers, 300)).toBeNull();
    expect(heldQualifyingSubscription([sub({ tier: 1 }), sub({ tier: 3 })], "s1", tiers, 300)?.tier).toBe(3);
    expect(heldQualifyingSubscription([], "s1", tiers, 0)).toBeNull();
  });

  test("minSubscriptionCents: from membership.classes, else the seeded default", () => {
    const at = (viewer: unknown) => [{ key: "membership.classes", value: { viewer } }];
    expect(minSubscriptionCents(at({ minSubscriptionCents: 450 }))).toBe(450);
    expect(minSubscriptionCents(at({ minSubscriptionCents: 0 }))).toBe(0);
    expect(minSubscriptionCents(at({}))).toBe(MEMBERSHIP_CLASSES_DEFAULTS.viewer.minSubscriptionCents);
    expect(minSubscriptionCents(at({ minSubscriptionCents: "450" }))).toBe(300);
    expect(minSubscriptionCents([])).toBe(300);
  });

  test("viewerState: the viewer row the view shows, or none", () => {
    expect(viewerState([])).toBe("none");
    expect(
      viewerState([
        { class: "streamer", status: "active", basis: "streaming_hours" },
        { class: "viewer", status: "exited", basis: "subscription" },
      ]),
    ).toBe("exited/subscription");
  });
});
