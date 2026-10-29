// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `channel-bot` step 4's pure parts: the signed-in swarm factory and how rows and balances are judged. */
import { describe, expect, test } from "vite-plus/test";
import type { Api } from "../../src/api/client.ts";
import { CookieJar } from "../../src/api/cookies.ts";
import { POINTS_PER_BLOCK, earnedWholeBlocks, sessionEarns, signedInSwarmFactory } from "../../src/e8/points.ts";

const account = () => ({ api: { jar: new CookieJar() } as unknown as Api });

describe("signedInSwarmFactory", () => {
  test("hands out each account's session once, with the plan's address and user agent", () => {
    const accounts = [account(), account()];
    const made: { clientIp: string; userAgent: string; jar: CookieJar }[] = [];
    const factory = signedInSwarmFactory(accounts, (o) => {
      made.push(o);
      return { jar: o.jar } as unknown as Api;
    });
    factory({ clientIp: "203.0.113.1", userAgent: "HeadlessChrome" });
    factory({ clientIp: "203.0.113.2", userAgent: "HeadlessChrome" });
    expect(made.map((m) => m.clientIp)).toEqual(["203.0.113.1", "203.0.113.2"]);
    expect(made.map((m) => m.userAgent)).toEqual(["HeadlessChrome", "HeadlessChrome"]);
    expect(made[0]?.jar).toBe(accounts[0]?.api.jar);
    expect(made[1]?.jar).toBe(accounts[1]?.api.jar);
  });

  test("refuses to run past the accounts (a session would be anonymous)", () => {
    const factory = signedInSwarmFactory([account()], () => ({}) as Api);
    factory({ clientIp: "203.0.113.1", userAgent: "x" });
    expect(() => factory({ clientIp: "203.0.113.2", userAgent: "x" })).toThrow(/account 2 of 1/);
  });
});

describe("earnedWholeBlocks", () => {
  test("a positive multiple of a block", () => {
    expect(POINTS_PER_BLOCK).toBe(10);
    expect(earnedWholeBlocks(10)).toBe(true);
    expect(earnedWholeBlocks(30)).toBe(true);
  });

  test("nothing, a part block, negatives and fractions fail", () => {
    expect(earnedWholeBlocks(0)).toBe(false);
    expect(earnedWholeBlocks(15)).toBe(false);
    expect(earnedWholeBlocks(-10)).toBe(false);
    expect(earnedWholeBlocks(10.5)).toBe(false);
  });

  test("another block size", () => {
    expect(earnedWholeBlocks(25, 5)).toBe(true);
    expect(earnedWholeBlocks(25, 10)).toBe(false);
  });
});

describe("sessionEarns (GATE_ELIGIBLE)", () => {
  const row = (verdict: string, reasons: string[] | null, scored = true) => ({
    id: "s",
    userId: "u",
    verdict,
    reasons,
    scored,
  });

  test("verified, judged and scored earns", () => {
    expect(sessionEarns(row("verified", []))).toBe(true);
    expect(sessionEarns(row("verified", null))).toBe(true);
  });

  test("pending, excluded, unscored and fetch_unjudged do not", () => {
    expect(sessionEarns(row("pending", []))).toBe(false);
    expect(sessionEarns(row("excluded", ["fetch_pattern"]))).toBe(false);
    expect(sessionEarns(row("verified", [], false))).toBe(false);
    expect(sessionEarns(row("verified", ["fetch_unjudged"]))).toBe(false);
  });
});
