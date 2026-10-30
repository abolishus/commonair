// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The surge guard's trigger and hysteresis (ADR 0015 decision 6). Pure, with the clock passed in:
 * the job reads the counts and the override, asks `decide`, and applies the answer.
 */
import type { SurgeOverride } from "@commonair/contracts/internal";

export const SURGE_WINDOW_MS = 2 * 60_000;
export const SURGE_TRAILING_MS = 15 * 60_000;
/** Only sessions at least this old are judged: verification takes about three heartbeats. */
export const SURGE_JUDGE_AFTER_MS = 60_000;
export const SURGE_MIN_NEW_SESSIONS = 20;
export const SURGE_RATE_MULTIPLIER = 3;
/** The override key outlives `until` by this much, so chat reopens on its own if the worker dies. */
export const SURGE_TTL_GRACE_SECONDS = 60;

export interface SurgeCounts {
  /** Sessions started in the last 2 minutes. */
  newSessions: number;
  /** Sessions started in the 15 minutes before that window. */
  trailingSessions: number;
  /** New sessions at least 60 s old. */
  judged: number;
  /** Of those, not gate-eligible. */
  unverified: number;
  /** A `follow_burst` flag on the channel in the last 2 minutes. */
  followBurst: boolean;
}

export type SurgeTrigger = "new_sessions" | "follow_burst";

/** `max(20, 3 × the trailing 15-minute rate per 2 minutes)`. */
export function newSessionThreshold(trailingSessions: number): number {
  const ratePer2Min = (Math.max(0, trailingSessions) * SURGE_WINDOW_MS) / SURGE_TRAILING_MS;
  return Math.max(SURGE_MIN_NEW_SESSIONS, Math.ceil(SURGE_RATE_MULTIPLIER * ratePer2Min));
}

/** Why the guard trips now, or null. */
export function surgeTrigger(c: SurgeCounts, triggerUnverifiedRatio: number): SurgeTrigger | null {
  if (
    c.newSessions >= newSessionThreshold(c.trailingSessions) &&
    c.judged > 0 &&
    c.unverified / c.judged >= triggerUnverifiedRatio
  )
    return "new_sessions";
  return c.followBurst ? "follow_burst" : null;
}

export type SurgeAction =
  /** The key lapsed without the job's end event (the worker was down): record it. */
  | { kind: "expired" }
  | { kind: "begin"; trigger: SurgeTrigger; next: SurgeOverride }
  | { kind: "extend"; next: SurgeOverride }
  /** `cause`: the channel's guard was turned off with surge mode still open (audit detail only). */
  | { kind: "end"; cause?: "guard_disabled" }
  /** A suppression ran out with nothing to start: drop the key quietly (the moderator's end was recorded). */
  | { kind: "clear" };

export interface SurgeInput {
  now: Date;
  current: SurgeOverride | null;
  /** A begin was recorded and no end yet (the job's marker). */
  open: boolean;
  trigger: SurgeTrigger | null;
  cooldownMinutes: number;
}

/** What the job does this run, in order. */
export function decide(i: SurgeInput): SurgeAction[] {
  const now = i.now.getTime();
  const until = new Date(now + i.cooldownMinutes * 60_000).toISOString();
  const begin = (trigger: SurgeTrigger): SurgeAction => ({
    kind: "begin",
    trigger,
    next: { state: "on", since: i.now.toISOString(), until, by: null },
  });
  const c = i.current;
  if (!c) {
    const out: SurgeAction[] = i.open ? [{ kind: "expired" }] : [];
    if (i.trigger) out.push(begin(i.trigger));
    return out;
  }
  const ended = now >= Date.parse(c.until);
  if (c.state === "suppressed") {
    // Never re-trigger before `until`.
    if (!ended) return [];
    return i.trigger ? [begin(i.trigger)] : [{ kind: "clear" }];
  }
  if (i.trigger) return Date.parse(until) > Date.parse(c.until) ? [{ kind: "extend", next: { ...c, until } }] : [];
  return ended ? [{ kind: "end" }] : [];
}

/** The override key's TTL: `until − now + 60 s` (at least one second). */
export function overrideTtlSeconds(o: SurgeOverride, now: Date): number {
  return Math.max(1, Math.ceil((Date.parse(o.until) - now.getTime()) / 1000) + SURGE_TTL_GRACE_SECONDS);
}
