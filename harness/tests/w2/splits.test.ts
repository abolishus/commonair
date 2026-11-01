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
  crewTid,
  expectedSlices,
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
