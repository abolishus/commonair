// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_GOVERNANCE_SETTINGS } from "@commonair/db";
import { PROPOSAL_STATUSES } from "@commonair/contracts/enums";
import { GovernanceRuleSnapshot } from "@commonair/contracts/shapes";
import {
  allowedTransitions,
  canTransition,
  classifyChanges,
  isContentEditable,
  isDeletable,
  isProtectedKey,
  rulesAcceptable,
  rulesFor,
  timeline,
} from "../src/rules.ts";
import { SettingError, ordinaryOf, protectionsOf, type SettingsMap } from "../src/settings.ts";

const settings: SettingsMap = Object.fromEntries(DEFAULT_GOVERNANCE_SETTINGS.map((s) => [s.key, s.value]));

describe("settings parsing", () => {
  test("the seeded defaults parse", () => {
    expect(protectionsOf(settings).memberWideThreshold).toBeCloseTo(2 / 3);
    expect(ordinaryOf(settings).threshold).toBe(0.5);
  });

  test("missing or out-of-range settings fail loudly with the key named", () => {
    expect(() => protectionsOf({})).toThrow(SettingError);
    const p = settings["governance.protections"] as Record<string, unknown>;
    expect(() => protectionsOf({ "governance.protections": { ...p, quorum: 0.6 } })).toThrow(/governance.protections/);
    expect(() => protectionsOf({ "governance.protections": { ...p, protectedKeys: ["platform.cut"] } })).toThrow(
      /protectedKeys/,
    );
    const o = settings["governance.ordinary"] as Record<string, unknown>;
    expect(() => ordinaryOf({ "governance.ordinary": { ...o, threshold: 1 } })).toThrow(/governance.ordinary/);
    expect(() => ordinaryOf({ "governance.ordinary": { ...o, votingSeconds: 1, minVotingSeconds: 2 } })).toThrow(
      /governance.ordinary/,
    );
    expect(() => ordinaryOf({ "governance.ordinary": { ...o, discussionSeconds: 7_776_001 } })).toThrow(
      /governance.ordinary/,
    );
  });
});

describe("protected keys and change classification", () => {
  test("governance.protections always protects itself", () => {
    expect(isProtectedKey("governance.protections", { protectedKeys: [] })).toBe(true);
    expect(isProtectedKey("platform.cut", protectionsOf(settings))).toBe(true);
    expect(isProtectedKey("discovery.ranking", protectionsOf(settings))).toBe(false);
  });

  test("any protected key makes the proposal protected and creator-affecting", () => {
    const r = classifyChanges(
      [
        { key: "discovery.ranking", value: {} },
        { key: "platform.cut", value: {} },
      ],
      settings,
    );
    expect(r).toEqual({ ok: true, kind: "protected", protectedKeys: ["platform.cut"], affectsCreatorsRequired: true });
  });

  test("only ordinary keys make an ordinary proposal", () => {
    expect(classifyChanges([{ key: "board.seats", value: {} }], settings)).toMatchObject({
      ok: true,
      kind: "ordinary",
      affectsCreatorsRequired: false,
    });
  });

  test("unknown, duplicate and empty change sets are reported", () => {
    expect(classifyChanges([], settings)).toEqual({ ok: false, problems: [{ code: "empty" }] });
    const r = classifyChanges(
      [
        { key: "nope.key", value: 1 },
        { key: "board.seats", value: 1 },
        { key: "board.seats", value: 2 },
      ],
      settings,
    );
    expect(r).toEqual({
      ok: false,
      problems: [
        { code: "unknown_key", key: "nope.key" },
        { code: "duplicate_key", key: "board.seats" },
      ],
    });
  });
});

describe("rule snapshots", () => {
  test("protected rules come from governance.protections and require council review", () => {
    const r = rulesFor("protected", settings);
    expect(GovernanceRuleSnapshot.parse(r)).toEqual(r);
    expect(r).toMatchObject({ protected: true, memberWideThreshold: 2 / 3, streamerClassThreshold: 0.5, quorum: 0.2 });
    expect(r.councilReviewRequired).toBe(true);
    expect(rulesAcceptable(r, "protected", settings)).toBe(true);
  });

  test("ordinary rules come from governance.ordinary", () => {
    const r = rulesFor("ordinary", settings, { affectsCreators: true });
    expect(GovernanceRuleSnapshot.parse(r)).toEqual(r);
    expect(r).toMatchObject({ protected: false, memberWideThreshold: 0.5, quorum: 0.1, councilReviewRequired: true });
    expect(rulesAcceptable(r, "ordinary", settings)).toBe(true);
  });

  test("weaker or mismatched rules are not acceptable", () => {
    const p = rulesFor("protected", settings);
    expect(rulesAcceptable({ ...p, memberWideThreshold: 0.6 }, "protected", settings)).toBe(false);
    expect(rulesAcceptable({ ...p, streamerClassQuorum: 0.1 }, "protected", settings)).toBe(false);
    expect(rulesAcceptable({ ...p, councilReviewRequired: false }, "protected", settings)).toBe(false);
    expect(rulesAcceptable(p, "ordinary", settings)).toBe(false);
    expect(rulesAcceptable({ ...p, memberWideThreshold: 0.9 }, "protected", settings)).toBe(true);
    const o = rulesFor("ordinary", settings);
    expect(rulesAcceptable({ ...o, quorum: 0.05 }, "ordinary", settings)).toBe(false);
    expect(rulesAcceptable({ ...o, memberWideThreshold: 1.5 }, "ordinary", settings)).toBe(false);
  });
});

describe("state machine", () => {
  test("transitions mirror the SQL list exactly", () => {
    const allowed = new Set(
      [
        ["draft", "discussion"],
        ["draft", "withdrawn"],
        ["discussion", "council_review"],
        ["discussion", "voting"],
        ["discussion", "withdrawn"],
        ["council_review", "voting"],
        ["council_review", "withdrawn"],
        ["voting", "passed"],
        ["voting", "rejected"],
        ["passed", "applied"],
      ].map((p) => p.join(">")),
    );
    for (const from of PROPOSAL_STATUSES) {
      for (const to of PROPOSAL_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  test("creator-affecting proposals must pass through council review", () => {
    expect(allowedTransitions("discussion", { affectsCreators: true })).toEqual(["council_review", "withdrawn"]);
    expect(allowedTransitions("discussion", { affectsCreators: false })).toEqual(["voting", "withdrawn"]);
    expect(allowedTransitions("voting")).toEqual(["passed", "rejected"]);
    expect(allowedTransitions("applied")).toEqual([]);
  });

  test("content editing and deletion windows", () => {
    expect(PROPOSAL_STATUSES.filter(isContentEditable)).toEqual(["draft", "discussion"]);
    expect(PROPOSAL_STATUSES.filter(isDeletable)).toEqual(["draft", "withdrawn"]);
  });
});

describe("timeline preview", () => {
  const now = new Date("2026-03-01T00:00:00Z");
  const day = 86_400_000;

  test("protected: discussion, then council review, then the protected minimum voting period", () => {
    const t = timeline(settings, now, { kind: "protected", affectsCreators: true });
    expect(t.discussionEndsAt.getTime() - now.getTime()).toBe(14 * day);
    expect(t.councilReviewEndsAt!.getTime() - t.discussionEndsAt.getTime()).toBe(7 * day);
    expect(t.votingOpensAt).toEqual(t.councilReviewEndsAt);
    expect(t.minVotingEndsAt.getTime() - t.votingOpensAt.getTime()).toBe(7 * day);
    expect(t.defaultVotingEndsAt.getTime() - t.votingOpensAt.getTime()).toBe(7 * day);
  });

  test("ordinary without creator impact skips council review", () => {
    const t = timeline(settings, now, { kind: "ordinary", affectsCreators: false });
    expect(t.councilReviewEndsAt).toBeNull();
    expect(t.votingOpensAt).toEqual(t.discussionEndsAt);
    expect(t.minVotingEndsAt.getTime() - t.votingOpensAt.getTime()).toBe(3 * day);
    expect(t.defaultVotingEndsAt.getTime() - t.votingOpensAt.getTime()).toBe(7 * day);
  });

  test("ordinary affecting creators still waits for council review", () => {
    const t = timeline(settings, now, { kind: "ordinary", affectsCreators: true });
    expect(t.councilReviewEndsAt).not.toBeNull();
  });
});
