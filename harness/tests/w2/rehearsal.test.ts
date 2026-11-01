// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `rehearsal` scenario's pure judgements and its test ids (src/w2/rehearsal/checks.ts). */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  REHEARSAL_TEST_IDS,
  VOD_EXPIRY_TOLERANCE_MS,
  heldWord,
  judgeChatReport,
  testIdSelector,
  vodExpiresInADay,
} from "../../src/w2/rehearsal/checks.ts";
import { REHEARSAL_STEP_RUNNERS } from "../../src/w2/rehearsal/index.ts";
import { REHEARSAL_STEP_NUMBERS } from "../../src/w2/steps.ts";

const zero = { wordFilter: 0, link: 0, duplicate: 0, rateLimit: 0, other: 0 };
const DAY = 86_400_000;

describe("judgeChatReport", () => {
  test("a filtered run passes", () => {
    const v = judgeChatReport({
      accepted: 120,
      held: { ...zero, wordFilter: 6 },
      rejected: { ...zero, link: 20, duplicate: 14, rateLimit: 3 },
    });
    expect(v).toEqual({ ok: true, missing: [], accepted: 120, held: 6, rejected: 37 });
  });

  test("each missing rule is named", () => {
    const v = judgeChatReport({ accepted: 3, held: zero, rejected: { ...zero, duplicate: 2 } });
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual([
      "accepted ≥ 30",
      "held by the word filter",
      "rejected as links",
      "burst caught as duplicates or by the rate limit",
    ]);
  });

  test("the burst may be caught by the rate limit instead of duplicates", () => {
    expect(
      judgeChatReport({ accepted: 40, held: { ...zero, wordFilter: 1 }, rejected: { ...zero, link: 1, rateLimit: 5 } })
        .ok,
    ).toBe(true);
  });
});

describe("vodExpiresInADay", () => {
  const end = new Date("2026-11-01T12:00:00Z");
  test("24 h after either anchor, within the tolerance", () => {
    expect(vodExpiresInADay(new Date(end.getTime() + DAY), [end])).toBe(true);
    expect(vodExpiresInADay(new Date(end.getTime() + DAY + VOD_EXPIRY_TOLERANCE_MS - 1), [end])).toBe(true);
    expect(vodExpiresInADay(new Date(end.getTime() + DAY + VOD_EXPIRY_TOLERANCE_MS + 1), [end])).toBe(false);
    const created = new Date(end.getTime() - 3_600_000);
    expect(vodExpiresInADay(new Date(created.getTime() + DAY), [end, created])).toBe(true);
  });

  test("no expiry, or a 30-day one, fails", () => {
    expect(vodExpiresInADay(null, [end])).toBe(false);
    expect(vodExpiresInADay(new Date(end.getTime() + 30 * DAY), [end])).toBe(false);
    expect(vodExpiresInADay(new Date(end.getTime() + DAY), [null])).toBe(false);
  });
});

describe("selectors", () => {
  test("data attributes become kebab-case attribute selectors", () => {
    expect(testIdSelector("rehearsal-status", { state: "armed" })).toBe(
      '[data-testid="rehearsal-status"][data-state="armed"]',
    );
    expect(testIdSelector("rehearsal-invitee", { username: "fan" })).toBe(
      '[data-testid="rehearsal-invitee"][data-username="fan"]',
    );
    expect(testIdSelector("x", { remainingSeconds: "5" })).toBe('[data-testid="x"][data-remaining-seconds="5"]');
  });

  test("every rehearsal id the scenario uses is in docs/testing/w2-selectors.md", () => {
    const doc = readFileSync(new URL("../../../docs/testing/w2-selectors.md", import.meta.url), "utf8");
    for (const id of Object.values(REHEARSAL_TEST_IDS)) expect(doc).toContain(`\`${id}\``);
  });

  test("the held word is a plain lowercase literal unique to the run", () => {
    expect(heldWord("Run-AB12_cd99")).toBe("rehearsalwordrunab12c");
    expect(heldWord("x")).toMatch(/^[a-z0-9]+$/);
  });
});

describe("runners", () => {
  test("every step has a real runner (none is the not-merged stub)", () => {
    expect(Object.keys(REHEARSAL_STEP_RUNNERS).map(Number)).toEqual([...REHEARSAL_STEP_NUMBERS]);
    for (const n of REHEARSAL_STEP_NUMBERS) expect(REHEARSAL_STEP_RUNNERS[n].toString()).not.toContain("not merged");
  });
});
