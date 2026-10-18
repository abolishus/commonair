// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { badgesFor, CHAT_COLOR_COUNT, colorFor } from "../src/badges.ts";
import { standing, user } from "./fixtures.ts";

describe("colorFor", () => {
  test("is stable and a token name, never hex", () => {
    const id = "0192f5a0-0000-7000-8000-000000000001";
    expect(colorFor(id)).toBe(colorFor(id));
    expect(colorFor(id)).toMatch(/^chat-(?:[1-9]|1[0-2])$/);
  });

  test("spreads users across the whole palette", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 2400; i++) {
      const c = colorFor(crypto.randomUUID());
      seen.set(c, (seen.get(c) ?? 0) + 1);
    }
    expect(seen.size).toBe(CHAT_COLOR_COUNT);
    // Roughly uniform: no color gets more than twice its fair share.
    for (const n of seen.values()) expect(n).toBeLessThan((2400 / CHAT_COLOR_COUNT) * 2);
  });
});

describe("badgesFor", () => {
  test("regular user has none", () => expect(badgesFor(user(), standing())).toEqual([]));

  test("broadcaster outranks moderator and VIP badges", () => {
    expect(badgesFor(user(), standing({ isBroadcaster: true, isModerator: true, isVip: true }))).toEqual([
      { type: "broadcaster" },
    ]);
  });

  test("full set in display order", () => {
    expect(
      badgesFor(
        user({ platformRole: "admin", isMember: true, accountType: "bot" }),
        standing({ isModerator: true, isVip: true, subscriberTier: 2 }),
      ),
    ).toEqual([
      { type: "staff" },
      { type: "moderator" },
      { type: "vip" },
      { type: "subscriber", tier: 2 },
      { type: "member" },
      { type: "bot" },
    ]);
  });

  test("platform moderators and treasurers are not staff", () => {
    expect(badgesFor(user({ platformRole: "moderator" }), standing())).toEqual([]);
    expect(badgesFor(user({ platformRole: "treasurer" }), standing())).toEqual([]);
  });
});
