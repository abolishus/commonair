// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { canActOn, canManageRoles, canModerate, type ChannelRank, rankOf, requiredRank } from "../src/permissions.ts";
import { standing } from "./fixtures.ts";

const RANKS: ChannelRank[] = ["broadcaster", "moderator", "vip", "user"];

/** actor → targets it may ban/timeout/delete. */
const MATRIX: Record<ChannelRank, ChannelRank[]> = {
  broadcaster: ["moderator", "vip", "user"],
  moderator: ["vip", "user"],
  vip: [],
  user: [],
};

describe("permission matrix: who can moderate whom", () => {
  for (const actor of RANKS)
    for (const target of RANKS) {
      const allowed = MATRIX[actor].includes(target);
      test(`${actor} → ${target}: ${allowed ? "allowed" : "denied"}`, () =>
        expect(canActOn(actor, target)).toBe(allowed));
    }
});

describe("ranks and command requirements", () => {
  test("rankOf prefers the highest role", () => {
    expect(rankOf(standing({ isBroadcaster: true, isModerator: true }))).toBe("broadcaster");
    expect(rankOf(standing({ isModerator: true, isVip: true }))).toBe("moderator");
    expect(rankOf(standing({ isVip: true, subscriberTier: 3 }))).toBe("vip");
    expect(rankOf(standing({ subscriberTier: 3 }))).toBe("user");
  });

  test("only broadcaster and moderators moderate; only the broadcaster manages roles", () => {
    expect(RANKS.filter(canModerate)).toEqual(["broadcaster", "moderator"]);
    expect(RANKS.filter(canManageRoles)).toEqual(["broadcaster"]);
  });

  test("required rank per command", () => {
    expect(requiredRank("me")).toBe("chat");
    for (const k of ["mod", "unmod", "vip", "unvip"] as const) expect(requiredRank(k)).toBe("broadcaster");
    for (const k of ["ban", "timeout", "delete", "clear", "slow", "emoteonly"] as const)
      expect(requiredRank(k)).toBe("moderator");
  });
});
