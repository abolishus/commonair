// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Giveaway rules (ADR 0039 §2): eligibility at every edge, entry order, winners against the
 * `packages/draw` vectors, the re-draw past an ineligible winner, the published-result check, and
 * that the eligibility schema cannot express a subscription, points or payment rule.
 */
import { describe, expect, test } from "vite-plus/test";
import { GiveawayEligibility } from "@commonair/contracts/shapes";
import { draw, pseudonym } from "@commonair/draw";
import vectors from "@commonair/draw/vectors.json" with { type: "json" };
import {
  giveawayIneligibility,
  pickWinners,
  sortEntries,
  winnersMatchDraw,
  type EntrantFacts,
} from "../src/giveaways.ts";

const DAY = 86_400_000;
const now = new Date("2026-11-01T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const rules = (r: Partial<GiveawayEligibility> = {}): GiveawayEligibility =>
  GiveawayEligibility.parse({ minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0, ...r });
const facts = (f: Partial<EntrantFacts> = {}): EntrantFacts => ({
  accountCreatedAt: ago(0),
  followedAt: null,
  verifiedWatchSeconds: 0,
  banned: false,
  ...f,
});
/** `packages/draw/src/vectors.ts` `entryList`. */
const entryList = (n: number) =>
  Array.from({ length: n }, (_, i) => `01890000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`);

describe("eligibility", () => {
  test("no rules: a brand-new account that follows nothing may enter", () => {
    expect(giveawayIneligibility(rules(), facts(), now)).toBeNull();
  });

  test("account age: exactly the minimum passes, a millisecond short fails", () => {
    const r = rules({ minAccountAgeDays: 7 });
    expect(giveawayIneligibility(r, facts({ accountCreatedAt: ago(7 * DAY) }), now)).toBeNull();
    expect(giveawayIneligibility(r, facts({ accountCreatedAt: ago(7 * DAY - 1) }), now)).toBe("account_age");
    // An account created in the future (clock skew) is younger than any minimum.
    expect(giveawayIneligibility(r, facts({ accountCreatedAt: ago(-DAY) }), now)).toBe("account_age");
  });

  test("following: null = not required; 0 = following required; N days at the edge", () => {
    expect(giveawayIneligibility(rules({ minFollowDays: null }), facts({ followedAt: null }), now)).toBeNull();
    expect(giveawayIneligibility(rules({ minFollowDays: 0 }), facts({ followedAt: null }), now)).toBe("not_following");
    expect(giveawayIneligibility(rules({ minFollowDays: 0 }), facts({ followedAt: ago(0) }), now)).toBeNull();
    const r = rules({ minFollowDays: 3 });
    expect(giveawayIneligibility(r, facts({ followedAt: ago(3 * DAY) }), now)).toBeNull();
    expect(giveawayIneligibility(r, facts({ followedAt: ago(3 * DAY - 1) }), now)).toBe("follow_age");
    expect(giveawayIneligibility(r, facts({ followedAt: null }), now)).toBe("not_following");
  });

  test("verified watch: 0 = not required; exactly the minimum passes, one second short fails", () => {
    expect(giveawayIneligibility(rules({ minVerifiedWatchSeconds: 0 }), facts(), now)).toBeNull();
    const r = rules({ minVerifiedWatchSeconds: 600 });
    expect(giveawayIneligibility(r, facts({ verifiedWatchSeconds: 600 }), now)).toBeNull();
    expect(giveawayIneligibility(r, facts({ verifiedWatchSeconds: 599 }), now)).toBe("verified_watch");
    expect(giveawayIneligibility(r, facts({ verifiedWatchSeconds: 0 }), now)).toBe("verified_watch");
  });

  test("banned wins over every other reason; the order of reasons is fixed", () => {
    const all = rules({ minAccountAgeDays: 30, minFollowDays: 10, minVerifiedWatchSeconds: 60 });
    expect(giveawayIneligibility(all, facts({ banned: true }), now)).toBe("banned");
    expect(giveawayIneligibility(all, facts(), now)).toBe("account_age");
    expect(giveawayIneligibility(all, facts({ accountCreatedAt: ago(30 * DAY) }), now)).toBe("not_following");
    expect(giveawayIneligibility(all, facts({ accountCreatedAt: ago(30 * DAY), followedAt: ago(DAY) }), now)).toBe(
      "follow_age",
    );
    expect(giveawayIneligibility(all, facts({ accountCreatedAt: ago(30 * DAY), followedAt: ago(10 * DAY) }), now)).toBe(
      "verified_watch",
    );
    expect(
      giveawayIneligibility(
        all,
        facts({ accountCreatedAt: ago(30 * DAY), followedAt: ago(10 * DAY), verifiedWatchSeconds: 60 }),
        now,
      ),
    ).toBeNull();
  });
});

describe("the eligibility schema", () => {
  test("has exactly the three free criteria", () => {
    expect(Object.keys(GiveawayEligibility.shape).sort()).toEqual([
      "minAccountAgeDays",
      "minFollowDays",
      "minVerifiedWatchSeconds",
    ]);
  });

  test.each([
    "subscriberOnly",
    "minSubscriberTier",
    "subscription",
    "points",
    "pointsCost",
    "entryCost",
    "price",
    "payment",
    "purchase",
  ])("refuses a %s criterion", (key) => {
    expect(GiveawayEligibility.safeParse({ [key]: 1 }).success).toBe(false);
    expect(GiveawayEligibility.safeParse({ [key]: true }).success).toBe(false);
  });

  test("refuses out-of-range values", () => {
    expect(GiveawayEligibility.safeParse({ minAccountAgeDays: -1 }).success).toBe(false);
    expect(GiveawayEligibility.safeParse({ minVerifiedWatchSeconds: 14_401 }).success).toBe(false);
    expect(GiveawayEligibility.safeParse({ minFollowDays: 1.5 }).success).toBe(false);
  });
});

describe("entries", () => {
  test("sorted by UTF-16 code unit, not locale", () => {
    expect(sortEntries(["b", "a", "B", "_"])).toEqual(["B", "_", "a", "b"]);
  });

  test("a duplicate pseudonym throws", () => {
    expect(() => sortEntries(["a", "b", "a"])).toThrow(/unique/);
  });

  test("the pseudonym is stable per salt and differs across salts", async () => {
    const salt = "a1".repeat(32);
    const other = "b2".repeat(32);
    const id = "01890000-0000-7000-8000-00000000000a";
    expect(await pseudonym(salt, id)).toBe(await pseudonym(salt, id));
    expect(await pseudonym(salt, id)).not.toBe(await pseudonym(other, id));
    expect(await pseudonym(salt, id)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("pseudonyms match the packages/draw vectors", async () => {
    for (const v of vectors.pseudonyms) expect(await pseudonym(v.salt, v.userId)).toBe(v.pseudonym);
  });
});

describe("winners", () => {
  test("with everyone eligible, the winners are the vector draw's first indices", async () => {
    const giveawayVectors = vectors.draws.filter((v) => v.domain === "" && v.size > 0 && v.count > 0);
    expect(giveawayVectors.length).toBeGreaterThan(0);
    for (const v of giveawayVectors) {
      const entries = entryList(v.size);
      const order = await draw(v.seed, entries, entries.length);
      const { winners, skipped } = pickWinners(order, () => true, v.count);
      expect(winners.map((w) => w.index)).toEqual(v.indices);
      expect(winners.map((w) => w.rank)).toEqual(v.indices.map((_, i) => i + 1));
      expect(skipped).toEqual([]);
      expect(winnersMatchDraw(order, winners, v.count)).toEqual({ match: true, skipped: 0 });
    }
  });

  test("an ineligible winner is skipped and the next drawn index takes the rank", () => {
    const order = [4, 1, 3, 0, 2];
    const { winners, skipped } = pickWinners(order, (i) => i !== 1, 2);
    expect(winners).toEqual([
      { rank: 1, index: 4 },
      { rank: 2, index: 3 },
    ]);
    expect(skipped).toEqual([1]);
    expect(winnersMatchDraw(order, winners, 2)).toEqual({ match: true, skipped: 1 });
  });

  test("the re-draw equals drawing one more: draw(k) is a prefix of draw(k + 1)", async () => {
    const entries = entryList(9);
    const seed = vectors.commitments[0]!.seed;
    const two = await draw(seed, entries, 2);
    const three = await draw(seed, entries, 3);
    expect(three.slice(0, 2)).toEqual(two);
    const { winners } = pickWinners(await draw(seed, entries, entries.length), (i) => i !== two[0], 2);
    expect(winners.map((w) => w.index)).toEqual([two[1], three[2]]);
  });

  test("fewer eligible entrants than winners: everyone eligible wins", () => {
    const order = [2, 0, 1];
    const { winners, skipped } = pickWinners(order, (i) => i !== 0, 5);
    expect(winners.map((w) => w.index)).toEqual([2, 1]);
    expect(skipped).toEqual([0]);
    expect(winnersMatchDraw(order, winners, 5)).toEqual({ match: true, skipped: 1 });
  });

  test("no entries: no winners, and that matches", () => {
    expect(pickWinners([], () => true, 3)).toEqual({ winners: [], skipped: [] });
    expect(winnersMatchDraw([], [], 3)).toEqual({ match: true, skipped: 0 });
  });

  test("a result that does not follow from the draw does not match", () => {
    const order = [4, 1, 3, 0, 2];
    // Out of drawn order.
    expect(
      winnersMatchDraw(
        order,
        [
          { rank: 1, index: 1 },
          { rank: 2, index: 4 },
        ],
        2,
      ).match,
    ).toBe(false);
    // An index the draw never produced.
    expect(winnersMatchDraw(order, [{ rank: 1, index: 9 }], 1).match).toBe(false);
    // More winners than asked.
    expect(
      winnersMatchDraw(
        order,
        [
          { rank: 1, index: 4 },
          { rank: 2, index: 1 },
        ],
        1,
      ).match,
    ).toBe(false);
    // A gap in the ranks.
    expect(winnersMatchDraw(order, [{ rank: 2, index: 4 }], 2).match).toBe(false);
  });
});
