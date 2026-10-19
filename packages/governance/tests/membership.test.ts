// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `subscriptionQualifies`: which subscriptions qualify their holder for viewer membership. */
import { describe, expect, test } from "vite-plus/test";
import { SUBSCRIPTION_STATUSES } from "@commonair/contracts";
import { DEFAULT_GOVERNANCE_SETTINGS } from "@commonair/db";
import { subscriptionQualifies, viewerEligible, type SubscriptionFacts } from "../src/membership.ts";
import { membershipClassesOf, type MembershipClasses } from "../src/settings.ts";

const rules = membershipClassesOf(Object.fromEntries(DEFAULT_GOVERNANCE_SETTINGS.map((s) => [s.key, s.value])));
const MIN = rules.viewer.minSubscriptionCents;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const DAY = 86_400_000;

const sub = (o: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  status: "active",
  priceCents: MIN,
  provider: "stripe",
  currentPeriodEnd: later(30 * DAY),
  giftedById: null,
  ownChannel: false,
  ...o,
});
const qualifies = (o: Partial<SubscriptionFacts> = {}, r: Pick<MembershipClasses, "viewer"> = rules) =>
  subscriptionQualifies(sub(o), NOW, r);

describe("subscriptionQualifies", () => {
  test("the defaults read from the seeded settings (minimum 300 cents)", () => {
    expect(MIN).toBe(300);
    expect(qualifies()).toBe(true);
  });

  test("only active subscriptions qualify", () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(qualifies({ status }), status).toBe(status === "active");
    }
    expect(qualifies({ status: "ACTIVE" })).toBe(false);
    expect(qualifies({ status: "" })).toBe(false);
  });

  test("price boundary: exactly the minimum qualifies, one cent under does not", () => {
    expect(qualifies({ priceCents: MIN })).toBe(true);
    expect(qualifies({ priceCents: MIN - 1 })).toBe(false);
    expect(qualifies({ priceCents: MIN + 1 })).toBe(true);
    expect(qualifies({ priceCents: 0 })).toBe(false);
  });

  test("tiers matter only through their price", () => {
    // Typical tier prices; a cheap promotional top tier still has to meet the minimum.
    for (const [priceCents, expected] of [
      [499, true],
      [999, true],
      [2499, true],
      [299, false],
      [100, false],
    ] as const) {
      expect(qualifies({ priceCents }), String(priceCents)).toBe(expected);
    }
  });

  test("a minimum of zero lets any active paid-through subscription qualify, including free ones", () => {
    const free = { viewer: { ...rules.viewer, minSubscriptionCents: 0 } };
    expect(qualifies({ priceCents: 0 }, free)).toBe(true);
    expect(qualifies({ priceCents: 0, status: "canceled" }, free)).toBe(false);
  });

  test("a raised minimum is honoured", () => {
    const strict = { viewer: { ...rules.viewer, minSubscriptionCents: 1000 } };
    expect(qualifies({ priceCents: 999 }, strict)).toBe(false);
    expect(qualifies({ priceCents: 1000 }, strict)).toBe(true);
  });

  test("gifted subscriptions never qualify: the holder did not pay", () => {
    expect(qualifies({ giftedById: "01900000-0000-7000-8000-000000000001" })).toBe(false);
    expect(qualifies({ giftedById: "01900000-0000-7000-8000-000000000001", provider: "manual" })).toBe(false);
  });

  test("a subscription to one's own channel never qualifies", () => {
    expect(qualifies({ ownChannel: true })).toBe(false);
    expect(qualifies({ ownChannel: true, provider: "manual", currentPeriodEnd: null })).toBe(false);
  });

  test("paid-through date: strictly after now qualifies; at or before now does not", () => {
    expect(qualifies({ currentPeriodEnd: later(1) })).toBe(true);
    expect(qualifies({ currentPeriodEnd: NOW })).toBe(false);
    expect(qualifies({ currentPeriodEnd: later(-1) })).toBe(false);
    expect(qualifies({ currentPeriodEnd: later(-30 * DAY) })).toBe(false);
    expect(qualifies({ currentPeriodEnd: later(365 * DAY) })).toBe(true);
  });

  test("the paid-through comparison is by instant, not by the clock's time zone or the Date object", () => {
    const same = new Date("2026-06-15T14:00:00.000+02:00"); // NOW, written with an offset
    expect(same.getTime()).toBe(NOW.getTime());
    expect(qualifies({ currentPeriodEnd: same })).toBe(false);
    expect(qualifies({ currentPeriodEnd: new Date("2026-06-15T14:00:00.001+02:00") })).toBe(true);
  });

  test("a missing paid-through date qualifies only for the manual provider", () => {
    expect(qualifies({ currentPeriodEnd: null, provider: "manual" })).toBe(true);
    expect(qualifies({ currentPeriodEnd: null, provider: "stripe" })).toBe(false);
    expect(qualifies({ currentPeriodEnd: null, provider: "other" })).toBe(false);
    // The other rules still apply to manual subscriptions without a date.
    expect(qualifies({ currentPeriodEnd: null, provider: "manual", status: "past_due" })).toBe(false);
    expect(qualifies({ currentPeriodEnd: null, provider: "manual", priceCents: MIN - 1 })).toBe(false);
  });

  test("a manual subscription with a lapsed date does not qualify (the date wins when present)", () => {
    expect(qualifies({ provider: "manual", currentPeriodEnd: later(-1) })).toBe(false);
    expect(qualifies({ provider: "manual", currentPeriodEnd: later(1) })).toBe(true);
  });

  test("cancelled subscriptions stay out even while paid through", () => {
    expect(qualifies({ status: "canceled", currentPeriodEnd: later(10 * DAY) })).toBe(false);
  });

  test("feeds viewerEligible only when subscriptions qualify for the instance", () => {
    const q = qualifies();
    expect(viewerEligible(null, q, rules)).toBe(true);
    const off = { viewer: { ...rules.viewer, activeSubscriptionQualifies: false } };
    expect(viewerEligible(null, subscriptionQualifies(sub(), NOW, off), off)).toBe(false);
  });
});
