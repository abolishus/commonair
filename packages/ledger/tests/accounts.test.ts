// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { accounts, describeAccount, isDebitNormal, parseStoredCode, storedCode } from "../src/accounts.ts";

const USER = "01890000-0000-7000-8000-000000000001";

describe("chart of accounts", () => {
  test("every builder produces a code the chart recognizes, with the right type and owner", () => {
    const cases: [string, string, string | null][] = [
      [accounts.cash("stripe"), "asset", null],
      [accounts.providerReceivable("manual"), "asset", null],
      [accounts.creatorReceivable(USER), "asset", USER],
      [accounts.creator(USER), "liability", USER],
      [accounts.creatorHold(USER), "liability", USER],
      [accounts.taxPayable(), "liability", null],
      [accounts.memberShare(USER), "liability", USER],
      [accounts.patronagePayable(USER), "liability", USER],
      [accounts.platformCut(), "revenue", null],
      [accounts.paymentFees(), "expense", null],
      [accounts.infrastructure("hosting"), "expense", null],
      [accounts.retainedSurplus(), "equity", null],
    ];
    for (const [code, type, owner] of cases) {
      const info = describeAccount(code);
      expect(info.type).toBe(type);
      expect(info.ownerUserId).toBe(owner);
      expect(info.name.length).toBeGreaterThan(0);
    }
  });

  test("creator and creator-hold codes are distinct and not prefixes of each other", () => {
    expect(accounts.creator(USER)).toBe(`liability:creator:${USER}`);
    expect(accounts.creatorHold(USER).startsWith("liability:creator:")).toBe(false);
  });

  test("user ids are normalized to lowercase; garbage is rejected", () => {
    expect(accounts.creator(USER.toUpperCase())).toBe(accounts.creator(USER));
    expect(() => accounts.creator("alice@example.test")).toThrow(RangeError);
    expect(() => accounts.infrastructure("Hosting Costs")).toThrow(RangeError);
    expect(() => describeAccount("asset:cash")).toThrow(RangeError);
    expect(() => describeAccount("liability:creator:not-a-uuid")).toThrow(RangeError);
  });

  test("stored codes carry the currency and round-trip", () => {
    const s = storedCode(accounts.creator(USER), "usd");
    expect(s).toBe(`liability:creator:${USER}@usd`);
    expect(parseStoredCode(s)).toEqual({ code: accounts.creator(USER), currency: "usd" });
    expect(() => storedCode("revenue:platform-cut", "USD")).toThrow(RangeError);
    expect(() => parseStoredCode("revenue:platform-cut")).toThrow(RangeError);
  });

  test("normal balance direction", () => {
    expect(isDebitNormal("asset")).toBe(true);
    expect(isDebitNormal("expense")).toBe(true);
    expect(isDebitNormal("liability")).toBe(false);
    expect(isDebitNormal("revenue")).toBe(false);
    expect(isDebitNormal("equity")).toBe(false);
  });
});
