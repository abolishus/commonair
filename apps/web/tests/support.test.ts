// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import {
  SUBSCRIPTION_STATUS_VIEW,
  canCancel,
  checkoutErrorMessage,
  checkoutRequest,
  giftCount,
  giftError,
  giftPresets,
  initialTab,
  parseCount,
  periodEndKey,
  sortSubscriptions,
  splitCents,
  splitPercents,
  supportTotal,
  tabAvailability,
  tipError,
  tipPresets,
  type GiftDraft,
  type SupportDraft,
} from "../src/lib/support.ts";
import { TIERS, subscription, supportInfo } from "./support-fixtures.ts";

const draft = (over: Partial<SupportDraft> = {}): SupportDraft => ({
  tab: "sub",
  tier: 1,
  gift: { count: "1", mode: "random", to: "" },
  tip: { cents: 500, message: "", anonymous: false },
  ...over,
});
const gift = (over: Partial<GiftDraft>): GiftDraft => ({ count: "1", mode: "random", to: "", ...over });

describe("tabAvailability", () => {
  it("opens every tab for a viewer with no subscription", () => {
    const av = tabAvailability(supportInfo());
    expect([av.sub.enabled, av.gift.enabled, av.tip.enabled]).toEqual([true, true, true]);
    expect(initialTab(av)).toBe("sub");
  });

  it("closes sub and gift with a reason until all three tiers exist; tips stay open", () => {
    for (const tiers of [[], TIERS.slice(0, 2)]) {
      const av = tabAvailability(supportInfo({ tiers }));
      expect(av.sub).toEqual({ enabled: false, reason: "support.reason.noTiers" });
      expect(av.gift).toEqual({ enabled: false, reason: "support.reason.noTiers" });
      expect(av.tip.enabled).toBe(true);
      expect(initialTab(av)).toBe("tip");
    }
  });

  it.each(["active", "past_due"] as const)("closes sub (not gift) while you hold a %s subscription", (status) => {
    const av = tabAvailability(supportInfo({ viewer: { isOwner: false, subscription: subscription({ status }) } }));
    expect(av.sub).toEqual({ enabled: false, reason: "support.reason.subscribed" });
    expect(av.gift.enabled).toBe(true);
    expect(initialTab(av)).toBe("gift");
  });

  it.each(["incomplete", "canceled", "expired"] as const)("keeps sub open with a %s subscription", (status) => {
    const av = tabAvailability(supportInfo({ viewer: { isOwner: false, subscription: subscription({ status }) } }));
    expect(av.sub.enabled).toBe(true);
  });

  it("closes everything for the owner and for anonymous callers keeps the tabs open", () => {
    const owner = tabAvailability(supportInfo({ viewer: { isOwner: true, subscription: null } }));
    expect([owner.sub.enabled, owner.gift.enabled, owner.tip.enabled]).toEqual([false, false, false]);
    expect(owner.tip.reason).toBe("support.reason.owner");
    expect(tabAvailability(supportInfo({ viewer: null })).sub.enabled).toBe(true);
  });

  it("every reason is a catalog key", () => {
    for (const key of ["support.reason.noTiers", "support.reason.subscribed", "support.reason.owner"])
      expect(key in en).toBe(true);
  });
});

describe("gift validation", () => {
  it("parses only plain whole numbers", () => {
    expect(parseCount("5")).toBe(5);
    expect(parseCount(" 25 ")).toBe(25);
    for (const bad of ["", "1.5", "-1", "1e2", "abc", "1234567"]) expect(parseCount(bad)).toBeNull();
  });

  it("accepts 1 to maxCount at random, rejects the edges", () => {
    expect(giftCount(gift({ count: "1" }), 100)).toBe(1);
    expect(giftCount(gift({ count: "100" }), 100)).toBe(100);
    expect(giftCount(gift({ count: "0" }), 100)).toBeNull();
    expect(giftCount(gift({ count: "101" }), 100)).toBeNull();
    expect(giftError(gift({ count: "0" }), 100)).toBe("support.gift.invalidCount");
    expect(giftError(gift({ count: "3" }), 100)).toBeNull();
  });

  it("a named viewer always gets exactly one, whatever the count says", () => {
    expect(giftCount(gift({ mode: "viewer", count: "50", to: "mothwing" }), 100)).toBe(1);
    expect(giftError(gift({ mode: "viewer", count: "abc", to: "mothwing" }), 100)).toBeNull();
  });

  it("needs a valid username for a named viewer (trimmed, @ and case forgiven)", () => {
    expect(giftError(gift({ mode: "viewer", to: " @MothWing " }), 100)).toBeNull();
    for (const bad of ["", "ab", "has space", "x".repeat(26), "dash-name"])
      expect(giftError(gift({ mode: "viewer", to: bad }), 100)).toBe("support.gift.invalidTo");
  });

  it("presets never exceed the channel's maximum", () => {
    expect(giftPresets(100)).toEqual([1, 5, 10, 25]);
    expect(giftPresets(10)).toEqual([1, 5, 10]);
  });
});

describe("tips", () => {
  const limits = supportInfo().tip;
  it("bounds the amount by the limits", () => {
    expect(tipError({ cents: limits.minCents, message: "", anonymous: false }, limits)).toBeNull();
    expect(tipError({ cents: limits.maxCents, message: "", anonymous: false }, limits)).toBeNull();
    expect(tipError({ cents: limits.minCents - 1, message: "", anonymous: false }, limits)).toBe(
      "support.tip.invalidAmount",
    );
    expect(tipError({ cents: limits.maxCents + 1, message: "", anonymous: false }, limits)).toBe(
      "support.tip.invalidAmount",
    );
    expect(tipError({ cents: 150.5, message: "", anonymous: false }, limits)).toBe("support.tip.invalidAmount");
  });

  it("unparsed amount text is invalid even when the last parsed cents were fine", () => {
    const tip = { cents: limits.minCents, message: "", anonymous: false, unparsed: true };
    expect(tipError(tip, limits)).toBe("support.tip.unparsed");
    expect(
      supportTotal(supportInfo(), { tab: "tip", tier: 1, gift: { count: "1", mode: "random", to: "" }, tip }),
    ).toBeNull();
  });

  it("drops presets outside the limits", () => {
    expect(tipPresets(limits)).toEqual([200, 500, 1000, 2000]);
    expect(tipPresets({ ...limits, minCents: 600 })).toEqual([1000, 2000]);
  });
});

describe("supportTotal", () => {
  const info = supportInfo();
  it("sub: the chosen tier's price", () => {
    expect(supportTotal(info, draft({ tier: 2 }))).toBe(999);
  });

  it("gift: count × tier price, in integer cents", () => {
    expect(supportTotal(info, draft({ tab: "gift", tier: 1, gift: gift({ count: "5" }) }))).toBe(2495);
    expect(supportTotal(info, draft({ tab: "gift", tier: 3, gift: gift({ count: "100" }) }))).toBe(249_900);
    expect(supportTotal(info, draft({ tab: "gift", gift: gift({ count: "0" }) }))).toBeNull();
    expect(supportTotal(info, draft({ tab: "gift", tier: 2, gift: gift({ mode: "viewer", to: "mothwing" }) }))).toBe(
      999,
    );
  });

  it("tip: the typed amount, null when invalid or the message is too long", () => {
    expect(supportTotal(info, draft({ tab: "tip", tip: { cents: 1234, message: "", anonymous: true } }))).toBe(1234);
    expect(supportTotal(info, draft({ tab: "tip", tip: { cents: 99, message: "", anonymous: false } }))).toBeNull();
    const long = "x".repeat(info.tip.messageMaxLength + 1);
    expect(supportTotal(info, draft({ tab: "tip", tip: { cents: 500, message: long, anonymous: false } }))).toBeNull();
  });

  it("null on a closed tab", () => {
    expect(supportTotal(supportInfo({ tiers: [] }), draft({ tab: "sub" }))).toBeNull();
  });
});

describe("splitCents", () => {
  it("floors the creator share like the ledger and gives the co-op the rest", () => {
    expect(splitCents(999, { streamerShare: 0.9, coopShare: 0.1 })).toEqual({ creator: 899, coop: 100 });
    expect(splitCents(500, { streamerShare: 0.9, coopShare: 0.1 })).toEqual({ creator: 450, coop: 50 });
    expect(splitCents(1, { streamerShare: 0.9, coopShare: 0.1 })).toEqual({ creator: 0, coop: 1 });
    expect(splitCents(0, { streamerShare: 0.9, coopShare: 0.1 })).toEqual({ creator: 0, coop: 0 });
  });

  it("is exact where floats are not (0.7 × 100 = 70.00000000000001)", () => {
    expect(splitCents(100, { streamerShare: 0.7, coopShare: 0.3 })).toEqual({ creator: 70, coop: 30 });
    expect(splitCents(1_000_000, { streamerShare: 0.85, coopShare: 0.15 })).toEqual({
      creator: 850_000,
      coop: 150_000,
    });
  });

  it("parts always sum to the total", () => {
    for (const total of [1, 7, 499, 2495, 99_999])
      for (const share of [0, 0.333333, 0.5, 0.9, 1]) {
        const p = splitCents(total, { streamerShare: share, coopShare: 1 - share });
        expect(p.creator + p.coop).toBe(total);
        expect(Number.isInteger(p.creator) && p.creator >= 0 && p.coop >= 0).toBe(true);
      }
  });

  it("percent labels sum to 100", () => {
    expect(splitPercents({ streamerShare: 0.9, coopShare: 0.1 })).toEqual({ creator: 90, coop: 10 });
    expect(splitPercents({ streamerShare: 0.333, coopShare: 0.667 })).toEqual({ creator: 33, coop: 67 });
  });
});

describe("checkoutRequest", () => {
  const info = supportInfo();
  it("sub", () => {
    expect(checkoutRequest("rivertide", info, draft({ tier: 3 }), "/rivertide")).toEqual({
      kind: "subscribe",
      input: { channel: "rivertide", tier: 3, returnPath: "/rivertide" },
    });
  });

  it("gift at random and to a named viewer", () => {
    expect(checkoutRequest("rivertide", info, draft({ tab: "gift", gift: gift({ count: "2" }) }), "/r")).toEqual({
      kind: "subscribe",
      input: { channel: "rivertide", tier: 1, gift: { count: 2 }, returnPath: "/r" },
    });
    expect(
      checkoutRequest("rivertide", info, draft({ tab: "gift", gift: gift({ mode: "viewer", to: "@MothWing" }) }), "/r"),
    ).toEqual({
      kind: "subscribe",
      input: { channel: "rivertide", tier: 1, gift: { count: 1, to: "mothwing" }, returnPath: "/r" },
    });
  });

  it("tip with a trimmed message and anonymity", () => {
    const req = checkoutRequest(
      "rivertide",
      info,
      draft({ tab: "tip", tip: { cents: 500, message: "  hi  ", anonymous: true } }),
      "/r",
    );
    expect(req).toEqual({
      kind: "tip",
      input: { channel: "rivertide", amountCents: 500, message: "hi", anonymous: true, returnPath: "/r" },
    });
  });

  it("null while invalid", () => {
    expect(checkoutRequest("rivertide", info, draft({ tab: "gift", gift: gift({ count: "" }) }), "/r")).toBeNull();
  });
});

describe("checkoutErrorMessage", () => {
  it("shows the API's message for a refused checkout", () => {
    const err = { code: "PRECONDITION_FAILED", message: "Only 1 viewer can receive a gift right now" };
    expect(checkoutErrorMessage(err)).toBe("Only 1 viewer can receive a gift right now");
  });

  it("never shows server internals: generic text for other codes and unknown errors", () => {
    expect(checkoutErrorMessage({ code: "INTERNAL_SERVER_ERROR", message: "select * from" })).toBe(
      en["support.error.generic"],
    );
    expect(checkoutErrorMessage(new Error("boom"))).toBe(en["support.error.generic"]);
    expect(checkoutErrorMessage({ code: "CONFLICT", message: "" })).toBe(en["support.error.generic"]);
  });

  it("asks to sign in again when the session is gone", () => {
    expect(checkoutErrorMessage({ code: "UNAUTHORIZED", message: "x" })).toBe(en["auth.sessionExpired"]);
  });
});

describe("subscriptions", () => {
  it("every status has a catalog label", () => {
    for (const view of Object.values(SUBSCRIPTION_STATUS_VIEW)) expect(view.key in en).toBe(true);
  });

  it("cancel only for active, paid rows not already cancelling", () => {
    expect(canCancel(subscription())).toBe(true);
    expect(canCancel(subscription({ cancelAtPeriodEnd: true }))).toBe(false);
    // Gifted subscriptions never renew: nothing to cancel.
    expect(canCancel(subscription({ gifted: true }))).toBe(false);
    for (const status of ["incomplete", "past_due", "canceled", "expired"] as const)
      expect(canCancel(subscription({ status }))).toBe(false);
  });

  it("says Ends when it will not renew", () => {
    expect(periodEndKey(subscription())).toBe("subscriptions.renews");
    expect(periodEndKey(subscription({ cancelAtPeriodEnd: true }))).toBe("subscriptions.ends");
    expect(periodEndKey(subscription({ gifted: true }))).toBe("subscriptions.ends");
    expect(periodEndKey(subscription({ status: "canceled" }))).toBe("subscriptions.ends");
  });

  it("sorts current before ended, newest first", () => {
    const list = [
      subscription({ id: "a", status: "expired" }),
      subscription({ id: "b", status: "active", createdAt: "2026-10-01T00:00:00.000Z" }),
      subscription({ id: "c", status: "active", createdAt: "2026-10-10T00:00:00.000Z" }),
      subscription({ id: "d", status: "incomplete" }),
    ];
    expect(sortSubscriptions(list).map((s) => s.id)).toEqual(["c", "b", "d", "a"]);
  });
});
