// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { dto } from "@commonair/contracts";
import { EVENTS, type BusEvent } from "@commonair/contracts/events";
import {
  goalAchieved,
  followerId,
  goalBeginPayload,
  goalEndPayload,
  goalFromEvent,
  goalIncrement,
  goalProgressPayload,
  goalTargets,
  goalUnits,
  toGoal,
  type GoalRowLike,
} from "../src/goals.ts";

const CH = "0190f0aa-0000-7000-8000-000000000001";
const OTHER = "0190f0aa-0000-7000-8000-000000000002";
const START = new Date("2026-10-29T12:00:00.000Z");
const after = (s: number) => new Date(START.getTime() + s * 1000).toISOString();

let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}, over: Partial<BusEvent> = {}): BusEvent =>
  ({
    id: `0190f0aa-0000-7000-8000-${String(++seq).padStart(12, "0")}`,
    type,
    version: "1",
    channelId: CH,
    payload,
    occurredAt: after(1),
    ...over,
  }) as BusEvent;
const tip = (value: unknown, over: Partial<BusEvent> = {}) =>
  ev("channel.tip", { amount: { value, decimal_places: 2, currency: "usd" } }, over);

describe("goalUnits", () => {
  test("a follow is one follower", () =>
    expect(goalUnits(ev("channel.follow"))).toEqual({ type: "followers", amount: 1 }));
  test("every subscribe row counts once, gifted or not", () => {
    expect(goalUnits(ev("channel.subscribe", { is_gift: false }))).toEqual({ type: "subscriptions", amount: 1 });
    expect(goalUnits(ev("channel.subscribe", { is_gift: true }))).toEqual({ type: "subscriptions", amount: 1 });
  });
  test("the gift summary never counts (its rows already did)", () =>
    expect(goalUnits(ev("channel.subscription.gift", { total: 5 }))).toBeNull());
  test("a tip adds its minor units", () => expect(goalUnits(tip(1250))).toEqual({ type: "tips", amount: 1250 }));
  test("malformed or non-positive tips do not count", () => {
    expect(goalUnits(tip(0))).toBeNull();
    expect(goalUnits(tip(-5))).toBeNull();
    expect(goalUnits(tip(1.5))).toBeNull();
    expect(goalUnits(tip("100"))).toBeNull();
    expect(goalUnits(ev("channel.tip", {}))).toBeNull();
  });
  test("unrelated events do not count", () => {
    for (const type of ["channel.raid", "stream.online", "channel.subscription.end", "channel.goal.progress"])
      expect(goalUnits(ev(type))).toBeNull();
  });
});

describe("goalTargets", () => {
  test("an unrelated batch needs no query", () => {
    expect(goalTargets([])).toBeNull();
    expect(goalTargets([ev("stream.online"), ev("channel.subscription.gift")])).toBeNull();
    expect(goalTargets([ev("channel.follow", {}, { channelId: null })])).toBeNull();
  });
  test("channels and types of the counting events, deduplicated", () => {
    expect(
      goalTargets([
        ev("channel.follow"),
        ev("channel.follow"),
        tip(100, { channelId: OTHER }),
        ev("channel.subscription.gift", {}, { channelId: OTHER }),
      ]),
    ).toEqual({ channelIds: [CH, OTHER].sort(), types: ["followers", "tips"] });
  });
});

describe("goalIncrement", () => {
  const goal = (type: GoalRowLike["type"]) => ({ channelId: CH, type, startedAt: START });
  test("sums the matching events of the goal's channel", () => {
    const batch = [
      ev("channel.follow"),
      ev("channel.follow"),
      ev("channel.follow", {}, { channelId: OTHER }),
      ev("channel.subscribe", { is_gift: true }),
      ev("channel.subscribe", { is_gift: true }),
      ev("channel.subscription.gift", { total: 2 }),
      tip(500),
      tip(250),
    ];
    expect(goalIncrement(goal("followers"), batch)).toBe(2);
    expect(goalIncrement(goal("subscriptions"), batch)).toBe(2);
    expect(goalIncrement(goal("tips"), batch)).toBe(750);
  });
  test("events before the goal started do not count; one at the start does", () => {
    const batch = [
      ev("channel.follow", {}, { occurredAt: after(-1) }),
      ev("channel.follow", {}, { occurredAt: START.toISOString() }),
    ];
    expect(goalIncrement(goal("followers"), batch)).toBe(1);
  });
  test("nothing matching → 0", () => expect(goalIncrement(goal("tips"), [ev("channel.follow")])).toBe(0));
  test("followers: each account counts once per batch; follows without a user still count", () => {
    const batch = [
      ev("channel.follow", { user_id: "u1" }),
      ev("channel.follow", { user_id: "u1" }),
      ev("channel.follow", { user_id: "u2" }),
      ev("channel.follow", { user_id: "u1" }, { channelId: OTHER }),
      ev("channel.follow"),
    ];
    expect(goalIncrement(goal("followers"), batch)).toBe(3);
  });
  test("followers: accounts already relayed since the start do not count again; earlier ones do not block", () => {
    const batch = [
      ev("channel.follow", { user_id: "u1" }),
      ev("channel.follow", { user_id: "u2" }),
      ev("channel.follow", { user_id: "u3" }),
    ];
    const prior = [
      { channelId: CH, userId: "u1", occurredAt: START },
      { channelId: CH, userId: "u2", occurredAt: new Date(START.getTime() - 1) },
      { channelId: OTHER, userId: "u3", occurredAt: START },
    ];
    expect(goalIncrement(goal("followers"), batch, prior)).toBe(2);
  });
  test("prior follows never affect other goal types", () => {
    const prior = [{ channelId: CH, userId: "u1", occurredAt: START }];
    expect(goalIncrement(goal("tips"), [tip(100, { payload: { user_id: "u1", amount: { value: 100 } } })], prior)).toBe(
      100,
    );
  });
});

describe("followerId", () => {
  test("the user of a follow; null otherwise", () => {
    expect(followerId(ev("channel.follow", { user_id: "u1" }))).toBe("u1");
    expect(followerId(ev("channel.follow", { user_id: "" }))).toBeNull();
    expect(followerId(ev("channel.follow", null as unknown as Record<string, unknown>))).toBeNull();
    expect(followerId(ev("channel.subscribe", { user_id: "u1" }))).toBeNull();
  });
});

describe("achievement and payloads", () => {
  const c = { ownerId: "0190f0aa-0000-7000-8000-0000000000a1", slug: "chan", displayName: "Chan" };
  const g: GoalRowLike = {
    id: "0190f0aa-0000-7000-8000-0000000000c1",
    type: "followers",
    title: "Two follows",
    target: 2,
    current: 1,
    startedAt: START,
    endedAt: null,
  };
  test("achieved at the target, not below", () => {
    expect(goalAchieved(1, 2)).toBe(false);
    expect(goalAchieved(2, 2)).toBe(true);
    expect(goalAchieved(3, 2)).toBe(true);
  });
  test("payloads validate against the catalog", () => {
    expect(EVENTS["channel.goal.begin"].payload.parse(goalBeginPayload(c, g))).toBeTruthy();
    expect(EVENTS["channel.goal.progress"].payload.parse(goalProgressPayload(c, g))).toBeTruthy();
    const ended = { ...g, current: 2, endedAt: after(5) ? new Date(after(5)) : null };
    const end = goalEndPayload(c, ended);
    expect(EVENTS["channel.goal.end"].payload.parse(end)).toBeTruthy();
    expect(end.is_achieved).toBe(true);
    expect(goalEndPayload(c, { ...g, endedAt: START }).is_achieved).toBe(false);
    expect(() => goalEndPayload(c, g)).toThrow(/has not ended/);
  });
  test("the event round-trips to the Goal DTO (description → title, ended_at → endedAt)", () => {
    const begin = goalFromEvent({ type: "channel.goal.begin", payload: goalBeginPayload(c, g) });
    expect(begin).toEqual(toGoal(g));
    expect(dto.Goal.parse(begin)).toEqual(begin);
    const ended = { ...g, current: 2, endedAt: new Date(after(9)) };
    expect(goalFromEvent({ type: "channel.goal.end", payload: goalEndPayload(c, ended) })).toEqual(toGoal(ended));
  });
  test("other events and malformed payloads give no goal", () => {
    expect(goalFromEvent({ type: "channel.follow", payload: {} })).toBeNull();
    expect(goalFromEvent({ type: "channel.goal.progress", payload: { id: g.id } })).toBeNull();
    const { ended_at: _drop, ...noEnd } = goalEndPayload(c, { ...g, endedAt: START });
    expect(goalFromEvent({ type: "channel.goal.end", payload: noEnd })).toBeNull();
  });
});
