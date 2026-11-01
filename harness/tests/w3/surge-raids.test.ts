// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact` extension `surge-raid`'s pure checks (src/w3/surge-raids.ts). */
import { describe, expect, test } from "vite-plus/test";
import { RAID_RULES } from "@commonair/contracts/enums";
import type { SendResult } from "../../src/w1/surge.ts";
import { CHAT_BOTS, RAIDERS, raidBeginOk, raidChatOutcome } from "../../src/w3/surge-raids.ts";

const ok = (user: string): SendResult => ({ user, accepted: true, code: null });
const refused = (user: string, code: string | null = "msg_verified_watch"): SendResult => ({
  user,
  accepted: false,
  code,
});

describe("raidChatOutcome", () => {
  test("every raider accepted and every bot refused with the gate's notice passes", () => {
    expect(raidChatOutcome([ok("r1"), ok("r2"), ok("r3")], [refused("b1"), refused("b2")])).toEqual({
      ok: true,
      problems: [],
    });
  });
  test("a refused raider fails, naming the code", () => {
    const o = raidChatOutcome([ok("r1"), refused("r2")], [refused("b1")]);
    expect(o.ok).toBe(false);
    expect(o.problems).toEqual(["raider r2: refused with msg_verified_watch"]);
  });
  test("an accepted bot, or one refused for something else, fails", () => {
    const o = raidChatOutcome([ok("r1")], [ok("b1"), refused("b2", "msg_ratelimit"), refused("b3", null)]);
    expect(o.problems).toEqual([
      "bot b1: expected msg_verified_watch, got accepted",
      "bot b2: expected msg_verified_watch, got msg_ratelimit",
      "bot b3: expected msg_verified_watch, got null",
    ]);
  });
  test("nobody tried is a failure, not a pass", () => {
    expect(raidChatOutcome([], []).problems).toEqual(["no raider tried", "no bot tried"]);
  });
  test("the step's sizes: three raiders and at least one chatting bot", () => {
    expect(RAIDERS).toBe(3);
    expect(CHAT_BOTS).toBeGreaterThan(0);
  });
});

describe("raidBeginOk", () => {
  const executedAt = new Date("2026-11-01T12:00:00.000Z");
  const until = new Date(executedAt.getTime() + RAID_RULES.surgeMinutes * 60_000).toISOString();
  test("trigger raid, no moderator, surgeMinutes after the execute", () => {
    expect(raidBeginOk({ trigger: "raid", until, by_user_id: null }, executedAt)).toBe(true);
  });
  test("a loaded runner's few seconds of skew are tolerated, a different length is not", () => {
    const at = (ms: number) => new Date(Date.parse(until) + ms).toISOString();
    expect(raidBeginOk({ trigger: "raid", until: at(20_000), by_user_id: null }, executedAt)).toBe(true);
    expect(raidBeginOk({ trigger: "raid", until: at(-20_000), by_user_id: null }, executedAt)).toBe(true);
    expect(raidBeginOk({ trigger: "raid", until: at(5 * 60_000), by_user_id: null }, executedAt)).toBe(false);
  });
  test.each([
    ["another trigger", { trigger: "new_sessions", until, by_user_id: null }],
    ["a moderator's begin", { trigger: "raid", until, by_user_id: "0190f0aa-0000-7000-8000-00000000000d" }],
    ["no until", { trigger: "raid", by_user_id: null }],
    ["a bad until", { trigger: "raid", until: "soon", by_user_id: null }],
  ])("%s → false", (_name, payload) => {
    expect(raidBeginOk(payload, executedAt)).toBe(false);
  });
  test("no begin row → false", () => {
    expect(raidBeginOk(undefined, executedAt)).toBe(false);
  });
});
