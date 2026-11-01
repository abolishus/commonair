// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The advisory jury's API rules (ADR 0038): k-suppression, conflicts, who may sit, settings, grouping. */
import { ENFORCEMENT_REPORT_RULES, JURY_RULES } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import { ineligibility, isConflicted, parseJurySettings, publishTally, tallyByClause } from "../src/jury/rules.ts";

const S = { suppressed: true };
const n = (value: number) => ({ suppressed: false, value });

describe("k-suppression (k = 10, the transparency helper)", () => {
  test("the jury's k is the enforcement report's", () => {
    expect(JURY_RULES.k).toBe(ENFORCEMENT_REPORT_RULES.k);
  });

  test("9 votes in all: the whole row is suppressed, zeros included", () => {
    expect(publishTally({ agree: 9, disagree: 0, unsure: 0 })).toEqual({ agree: S, disagree: S, unsure: S });
    expect(publishTally({ agree: 4, disagree: 3, unsure: 2 })).toEqual({ agree: S, disagree: S, unsure: S });
  });

  test("10 votes: shown when every part is 0 or at least 10", () => {
    expect(publishTally({ agree: 10, disagree: 0, unsure: 0 })).toEqual({ agree: n(10), disagree: n(0), unsure: n(0) });
  });

  test("10 votes split under k: each part is suppressed", () => {
    expect(publishTally({ agree: 6, disagree: 4, unsure: 0 })).toEqual({ agree: S, disagree: S, unsure: n(0) });
  });

  test("11 votes: one small part hides the smallest visible one too (complementary)", () => {
    expect(publishTally({ agree: 10, disagree: 1, unsure: 0 })).toEqual({ agree: S, disagree: S, unsure: n(0) });
    expect(publishTally({ agree: 11, disagree: 0, unsure: 0 })).toEqual({ agree: n(11), disagree: n(0), unsure: n(0) });
  });

  test("larger rows publish their counts", () => {
    expect(publishTally({ agree: 20, disagree: 10, unsure: 0 })).toEqual({
      agree: n(20),
      disagree: n(10),
      unsure: n(0),
    });
  });
});

describe("conflicts", () => {
  const c = { channelId: "ch1", partyIds: ["subject", "owner", "reporter", null] };
  test("a party is conflicted", () => {
    for (const id of ["subject", "owner", "reporter"]) expect(isConflicted(id, c, new Set())).toBe(true);
  });
  test("a moderator of the case's channel is conflicted; of another channel, not", () => {
    expect(isConflicted("mod", c, new Set(["ch1"]))).toBe(true);
    expect(isConflicted("mod", c, new Set(["ch2"]))).toBe(false);
    expect(isConflicted("mod", { channelId: null, partyIds: [] }, new Set(["ch1"]))).toBe(false);
  });
  test("anyone else sees the case", () => {
    expect(isConflicted("juror", c, new Set())).toBe(false);
  });
});

describe("who may sit", () => {
  const ok = {
    role: "user" as const,
    accountType: "human" as const,
    suspended: false,
    activeMember: true,
    adult: true,
  };
  test("an active adult human member who is not staff", () => {
    expect(ineligibility(ok)).toBeNull();
  });
  test("each reason", () => {
    expect(ineligibility({ ...ok, role: "moderator" })).toBe("staff");
    expect(ineligibility({ ...ok, role: "treasurer" })).toBe("staff");
    expect(ineligibility({ ...ok, accountType: "bot" })).toBe("bot");
    expect(ineligibility({ ...ok, suspended: true })).toBe("suspended");
    expect(ineligibility({ ...ok, activeMember: false })).toBe("not_member");
    expect(ineligibility({ ...ok, adult: false })).toBe("not_adult");
  });
});

describe("settings", () => {
  test("off by default, defaults for sizes", () => {
    expect(parseJurySettings([])).toEqual({ enabled: false, panelSize: 7, casesPerPanel: 20 });
    expect(parseJurySettings([{ key: "jury.enabled", value: { enabled: "yes" } }]).enabled).toBe(false);
    expect(parseJurySettings([{ key: "jury.enabled", value: { enabled: true } }]).enabled).toBe(true);
  });
});

describe("grouping by clause and tier", () => {
  test("votes group by clause id and tier, with the newest version for the title", () => {
    const rows = tallyByClause([
      { clauseId: "honesty.spam", clauseVersion: 1, tier: null, vote: "agree" },
      { clauseId: "honesty.spam", clauseVersion: 2, tier: null, vote: "disagree" },
      { clauseId: "safety.weapons", clauseVersion: 1, tier: "t1", vote: "unsure" },
      { clauseId: "safety.weapons", clauseVersion: 1, tier: "t2", vote: "agree" },
    ]);
    expect(rows).toEqual([
      { clauseId: "honesty.spam", clauseVersion: 2, tier: null, tally: { agree: 1, disagree: 1, unsure: 0 } },
      { clauseId: "safety.weapons", clauseVersion: 1, tier: "t1", tally: { agree: 0, disagree: 0, unsure: 1 } },
      { clauseId: "safety.weapons", clauseVersion: 1, tier: "t2", tally: { agree: 1, disagree: 0, unsure: 0 } },
    ]);
  });
});
