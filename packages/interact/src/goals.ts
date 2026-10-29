// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Goal rules shared by the API (`interact.goals.*`, the overlay hub) and the worker's outbox-relay
 * hook (ADR 0026 decision 5, Amendment 1): which events advance which goal type and by how much,
 * achievement, the `channel.goal.*` payloads and the `Goal` DTO. Owned by E8-raids-goals.
 */
import type { GOAL_TYPES } from "@commonair/contracts/enums";
import type { BusEvent, EventPayload } from "@commonair/contracts/events";
import { broadcasterFields } from "./outbox.ts";

export type GoalType = (typeof GOAL_TYPES)[number];

/** How many units of a goal type one event is worth, or null when it does not count. */
export function goalUnits(ev: Pick<BusEvent, "type" | "payload">): { type: GoalType; amount: number } | null {
  switch (ev.type) {
    case "channel.follow":
      return { type: "followers", amount: 1 };
    // One row per subscription, gifted ones included. `channel.subscription.gift` only summarises
    // those rows, so counting it too would count every gift twice.
    case "channel.subscribe":
      return { type: "subscriptions", amount: 1 };
    case "channel.tip": {
      // The instance has one currency; minor units, like the goal's target.
      const value = (ev.payload.amount as { value?: unknown } | undefined)?.value;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
      return { type: "tips", amount: value };
    }
    default:
      return null;
  }
}

/** The channels and goal types a batch could advance, or null when nothing in it counts (no query). */
export function goalTargets(
  events: readonly Pick<BusEvent, "type" | "payload" | "channelId">[],
): { channelIds: string[]; types: GoalType[] } | null {
  const channels = new Set<string>();
  const types = new Set<GoalType>();
  for (const ev of events) {
    if (!ev.channelId) continue;
    const u = goalUnits(ev);
    if (!u) continue;
    channels.add(ev.channelId);
    types.add(u.type);
  }
  if (channels.size === 0) return null;
  return { channelIds: [...channels].sort(), types: [...types].sort() };
}

/**
 * What a batch adds to one open goal: events of its channel and type that occurred at or after the
 * goal started (a goal counts from zero at its start, decided 2026-10-29).
 */
export function goalIncrement(
  goal: { channelId: string; type: GoalType; startedAt: Date },
  events: readonly Pick<BusEvent, "type" | "payload" | "channelId" | "occurredAt">[],
): number {
  let n = 0;
  const from = goal.startedAt.getTime();
  for (const ev of events) {
    if (ev.channelId !== goal.channelId) continue;
    if (Date.parse(ev.occurredAt) < from) continue;
    const u = goalUnits(ev);
    if (u?.type === goal.type) n += u.amount;
  }
  return n;
}

/** A goal is achieved once its count reaches the target. */
export const goalAchieved = (current: number, target: number) => current >= target;

export interface GoalRowLike {
  id: string;
  type: GoalType;
  title: string;
  target: number;
  current: number;
  startedAt: Date;
  endedAt: Date | null;
}

export interface GoalChannel {
  ownerId: string;
  slug: string;
  displayName: string;
}

/** `Goal` DTO. */
export const toGoal = (g: GoalRowLike) => ({
  id: g.id,
  type: g.type,
  title: g.title,
  target: g.target,
  current: g.current,
  startedAt: g.startedAt.toISOString(),
  endedAt: g.endedAt ? g.endedAt.toISOString() : null,
});

const goalFields = (c: GoalChannel, g: GoalRowLike) => ({
  ...broadcasterFields(c),
  id: g.id,
  type: g.type,
  description: g.title,
  current_amount: g.current,
  target_amount: g.target,
  started_at: g.startedAt.toISOString(),
});

export const goalBeginPayload = (c: GoalChannel, g: GoalRowLike): EventPayload<"channel.goal.begin"> =>
  goalFields(c, g);

export const goalProgressPayload = (c: GoalChannel, g: GoalRowLike): EventPayload<"channel.goal.progress"> =>
  goalFields(c, g);

/** `channel.goal.end`; `g.endedAt` must be set. */
export function goalEndPayload(c: GoalChannel, g: GoalRowLike): EventPayload<"channel.goal.end"> {
  if (!g.endedAt) throw new Error("goalEndPayload: the goal has not ended");
  return {
    ...goalFields(c, g),
    is_achieved: goalAchieved(g.current, g.target),
    ended_at: g.endedAt.toISOString(),
  };
}

/**
 * The `Goal` DTO a `channel.goal.*` event describes (the overlay's SSE `goal` frame), or null for
 * other events and malformed payloads.
 */
export function goalFromEvent(ev: Pick<BusEvent, "type" | "payload">): ReturnType<typeof toGoal> | null {
  if (ev.type !== "channel.goal.begin" && ev.type !== "channel.goal.progress" && ev.type !== "channel.goal.end")
    return null;
  const p = ev.payload;
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  const current = int(p.current_amount);
  const target = int(p.target_amount);
  if (
    typeof p.id !== "string" ||
    typeof p.type !== "string" ||
    typeof p.description !== "string" ||
    typeof p.started_at !== "string" ||
    current === null ||
    target === null
  )
    return null;
  const endedAt = typeof p.ended_at === "string" ? p.ended_at : null;
  if (ev.type === "channel.goal.end" && endedAt === null) return null;
  return {
    id: p.id,
    type: p.type as GoalType,
    title: p.description,
    target,
    current,
    startedAt: p.started_at,
    endedAt,
  };
}
