// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `e4b-money` split steps' pure parts (src/w2/splits.ts). */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_PLATFORM_CUT } from "@commonair/ledger";
import {
  CREW_BPS,
  CREW_IDS,
  CREW_ROUTE,
  SPLIT_TIP_CENTS,
  crewEarnedSlice,
  crewPayoutTipCents,
  crewTid,
  expectedSlices,
  ownerClawbackOwed,
  splitFixtureDates,
} from "../../src/w2/splits.ts";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const DAY = 86_400_000;
const OWNER = "01890000-0000-7000-8000-00000000000a";
const CREW = "01890000-0000-7000-8000-0000000000b1";

describe("splitFixtureDates", () => {
  test("one fixture past the hold and the new-recipient days, one past the hold only", () => {
    expect(splitFixtureDates(NOW, 7, 7)).toEqual({
      released: new Date(NOW.getTime() - 15 * DAY),
      ownerOnly: new Date(NOW.getTime() - 8 * DAY),
    });
    expect(splitFixtureDates(NOW, 0.5, 1).released).toEqual(new Date(NOW.getTime() - 3 * DAY));
  });

  test("refuses a new-recipient hold that adds nothing", () => {
    expect(() => splitFixtureDates(NOW, 7, 0)).toThrow(RangeError);
  });
});

describe("expectedSlices", () => {
  test("the co-op cut first, then the crew's basis points of the creator share", () => {
    const s = expectedSlices(SPLIT_TIP_CENTS, DEFAULT_PLATFORM_CUT, OWNER, CREW);
    expect(s).toEqual({ owner: 1440, crew: 360, creator: 1800 });
    expect(CREW_BPS).toBe(2000);
  });

  test("the slices always sum to the creator share", () => {
    for (const gross of [1, 2, 99, 1001, 123_457]) {
      const s = expectedSlices(gross, { streamerShare: 0.873, coopShare: 0.127 }, OWNER, CREW.toUpperCase(), 3333);
      expect(s.owner + s.crew).toBe(s.creator);
    }
  });
});

describe("crewEarnedSlice", () => {
  // CI run 41285945456: the fixture's 360 released, the live (manual) tip's 360 still held.
  const ci = { liabilityCents: 360, holdCents: 360, receivableCents: 0, reservedCents: 0 };

  test("a live tip still inside the hold leaves its crew lot held", () => {
    expect(crewEarnedSlice(ci, 360, 360)).toBe(true);
    expect(crewEarnedSlice(ci, 360, 0)).toBe(false);
  });

  test("the released slice counts once, released or reserved for a payout", () => {
    expect(crewEarnedSlice({ liabilityCents: 0, reservedCents: 360, holdCents: 0 }, 360, 0)).toBe(true);
    expect(crewEarnedSlice({ liabilityCents: 360, reservedCents: 360, holdCents: 0 }, 360, 0)).toBe(false);
    expect(crewEarnedSlice({ liabilityCents: 0, reservedCents: 0, holdCents: 720 }, 360, 360)).toBe(false);
  });
});

describe("ownerClawbackOwed", () => {
  // CI run 41295322622: both lots released, the run reserved nothing (under the 2500 minimum).
  test("unpaid released earnings cover the owner's own slice first; the crew's is the shortfall", () => {
    expect(
      ownerClawbackOwed({ liabilityCents: 1440, holdCents: 0 }, { sliceCents: 1440, fromOwnLotCents: 0 }, 360),
    ).toEqual({ receivableCents: 0, splitShortfallCents: 360 });
  });

  test("with the owner's slice reserved for a payout, its own slice is the receivable", () => {
    expect(
      ownerClawbackOwed({ liabilityCents: 0, holdCents: 0 }, { sliceCents: 1440, fromOwnLotCents: 0 }, 360),
    ).toEqual({
      receivableCents: 1440,
      splitShortfallCents: 360,
    });
  });

  test("a partial cover splits own slice first, and held lots count after the own-lot draw", () => {
    expect(
      ownerClawbackOwed({ liabilityCents: 1000, holdCents: 0 }, { sliceCents: 1440, fromOwnLotCents: 0 }, 360),
    ).toEqual({ receivableCents: 440, splitShortfallCents: 360 });
    expect(
      ownerClawbackOwed({ liabilityCents: 1500, holdCents: 0 }, { sliceCents: 1440, fromOwnLotCents: 0 }, 360),
    ).toEqual({ receivableCents: 0, splitShortfallCents: 300 });
    // Inside the hold the own lot gave the whole slice; another lot of 200 covers part of the crew's.
    expect(
      ownerClawbackOwed({ liabilityCents: 0, holdCents: 1640 }, { sliceCents: 1440, fromOwnLotCents: 1440 }, 360),
    ).toEqual({ receivableCents: 0, splitShortfallCents: 160 });
    expect(ownerClawbackOwed({ liabilityCents: -50, holdCents: 0 }, { sliceCents: 0, fromOwnLotCents: 0 }, 0)).toEqual({
      receivableCents: 0,
      splitShortfallCents: 0,
    });
  });
});

describe("crewPayoutTipCents", () => {
  const cut = { streamerShare: 0.9, coopShare: 0.1 };
  // The proportional estimate, which the helper starts from and steps up by at most a few cents.
  const estimate = (min: number, c: typeof cut, bps: number) => Math.ceil((min * 10_000) / (bps * c.streamerShare));

  test("the seeded 2500 minimum: the crew slice reaches it", () => {
    const gross = crewPayoutTipCents(2500, cut, OWNER, CREW);
    expect(expectedSlices(gross, cut, OWNER, CREW).crew).toBeGreaterThanOrEqual(2500);
    expect(gross).toBeLessThanOrEqual(estimate(2500, cut, 2000) + 10);
    // The standard 2000 tip does not (CI run 41295322622: 360 carried over).
    expect(expectedSlices(SPLIT_TIP_CENTS, cut, OWNER, CREW).crew).toBeLessThan(2500);
  });

  test("never below the standard tip", () => {
    expect(crewPayoutTipCents(0, cut, OWNER, CREW)).toBe(SPLIT_TIP_CENTS);
    expect(crewPayoutTipCents(360, cut, OWNER, CREW)).toBe(SPLIT_TIP_CENTS);
  });

  test("odd cuts and shares still reach the minimum, close to the estimate", () => {
    const odd = { streamerShare: 0.873, coopShare: 0.127 };
    for (const [min, bps] of [
      [2500, 2000],
      [999, 333],
      [10_001, 7],
    ] as const) {
      const gross = crewPayoutTipCents(min, odd, OWNER, CREW, bps);
      expect(expectedSlices(gross, odd, OWNER, CREW, bps).crew).toBeGreaterThanOrEqual(min);
      expect(gross).toBeLessThanOrEqual(Math.max(SPLIT_TIP_CENTS, estimate(min, odd, bps)) + 1000);
    }
  });
});

describe("crew selectors", () => {
  test("every id is one docs/testing/w2-selectors.md lists", () => {
    const doc = readFileSync(new URL("../../../docs/testing/w2-selectors.md", import.meta.url), "utf8");
    for (const id of Object.values(CREW_IDS)) expect(doc).toContain(`\`${id}\``);
    expect(doc).toContain(`\`${CREW_ROUTE}\``);
  });

  test("attribute selectors are escaped", () => {
    expect(crewTid("crew-split", { status: "accepted" })).toBe('[data-testid="crew-split"][data-status="accepted"]');
    expect(crewTid("x", { a: 'q"\\' })).toBe('[data-testid="x"][data-a="q\\"\\\\"]');
  });
});
