// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat panel's poll, prediction and raid state (E8). Polls and predictions start from
 * `interact.*.current` and follow the channel's `channel.poll.*` / `channel.prediction.*` event
 * frames (validated against the event catalog; anything that fails is dropped); the outgoing raid
 * follows the source's `raid` control frames. Pure, for unit tests.
 */
import type * as D from "@commonair/contracts/dto";
import { EVENTS } from "@commonair/contracts/events";
import type { z } from "zod";

export type PollViewDto = z.infer<typeof D.PollView>;
export type PredictionViewDto = z.infer<typeof D.PredictionView>;
export type LoyaltyBalanceDto = z.infer<typeof D.LoyaltyBalance>;

/** How long an ended poll or prediction stays pinned with its results. */
export const RESULTS_VISIBLE_MS = 120_000;
/** Points chip refresh (and the prediction amount's bound) while the panel is open. */
export const POINTS_REFRESH_MS = 60_000;
/** The router's bound on `interact.predictions.bet` points (no shared constant in contracts yet). */
export const MAX_BET_POINTS = 250_000;

export const POLL_EVENT_TYPES = ["channel.poll.begin", "channel.poll.progress", "channel.poll.end"] as const;
export const PREDICTION_EVENT_TYPES = [
  "channel.prediction.begin",
  "channel.prediction.progress",
  "channel.prediction.lock",
  "channel.prediction.end",
] as const;
type PollEventType = (typeof POLL_EVENT_TYPES)[number];
type PredictionEventType = (typeof PREDICTION_EVENT_TYPES)[number];

export const isPollEvent = (type: string): type is PollEventType =>
  (POLL_EVENT_TYPES as readonly string[]).includes(type);
export const isPredictionEvent = (type: string): type is PredictionEventType =>
  (PREDICTION_EVENT_TYPES as readonly string[]).includes(type);

/**
 * Where an event frame goes: the poll or prediction card (a parsed frame), the log (`row`), or
 * nowhere (`drop`: a card frame that failed validation).
 */
export type InteractFrame =
  | { kind: "poll"; frame: PollFrame }
  | { kind: "prediction"; frame: PredictionFrame }
  | { kind: "row" }
  | { kind: "drop" };

export function routeEventFrame(type: string, data: unknown): InteractFrame {
  if (isPollEvent(type)) {
    const frame = parsePollFrame(type, data);
    return frame ? { kind: "poll", frame } : { kind: "drop" };
  }
  if (isPredictionEvent(type)) {
    const frame = parsePredictionFrame(type, data);
    return frame ? { kind: "prediction", frame } : { kind: "drop" };
  }
  return { kind: "row" };
}

// ------------------------------------------------------------------ polls

export interface PollFrame {
  type: PollEventType;
  id: string;
  title: string;
  choices: PollViewDto["choices"];
  pointsPerExtraVote: number;
  startedAt: string;
  endsAt: string | null;
  endedAt: string | null;
  status: PollViewDto["status"];
}

export function parsePollFrame(type: string, data: unknown): PollFrame | null {
  const choices = (cs: { id: string; title: string; votes: number }[]) =>
    cs.map((c) => ({ id: c.id, title: c.title, votes: c.votes }));
  const extra = (v: { is_enabled: boolean; amount_per_vote: number }) => (v.is_enabled ? v.amount_per_vote : 0);
  if (type === "channel.poll.end") {
    const p = EVENTS[type].payload.safeParse(data);
    if (!p.success) return null;
    return {
      type,
      id: p.data.id,
      title: p.data.title,
      choices: choices(p.data.choices),
      pointsPerExtraVote: extra(p.data.channel_points_voting),
      startedAt: p.data.started_at,
      endsAt: null,
      endedAt: p.data.ended_at,
      status: p.data.status,
    };
  }
  if (type === "channel.poll.begin" || type === "channel.poll.progress") {
    const p = EVENTS[type].payload.safeParse(data);
    if (!p.success) return null;
    return {
      type,
      id: p.data.id,
      title: p.data.title,
      choices: choices(p.data.choices),
      pointsPerExtraVote: extra(p.data.channel_points_voting),
      startedAt: p.data.started_at,
      endsAt: p.data.ends_at,
      endedAt: null,
      status: "active",
    };
  }
  return null;
}

/**
 * Apply a poll frame. A frame for another poll replaces it (a new poll started) and forgets the
 * viewer's vote; the viewer's own vote never comes from events. A late `progress` cannot reopen
 * a poll that already ended.
 */
export function applyPollFrame(current: PollViewDto | null, f: PollFrame): PollViewDto {
  const same = current?.id === f.id ? current : null;
  if (same && same.status !== "active" && f.status === "active") return same;
  return {
    id: f.id,
    title: f.title,
    choices: f.choices,
    status: f.status,
    startedAt: f.startedAt,
    endsAt: f.endsAt ?? same?.endsAt ?? f.endedAt ?? f.startedAt,
    endedAt: f.endedAt,
    pointsPerExtraVote: f.pointsPerExtraVote,
    myVote: same?.myVote ?? null,
    myVotes: same?.myVotes ?? 0,
  };
}

/** Pinned while active, and for a while after it ended (never once archived). */
export function pollVisible(poll: PollViewDto | null, now: number): poll is PollViewDto {
  if (!poll || poll.status === "archived") return false;
  if (poll.status === "active") return true;
  const ended = Date.parse(poll.endedAt ?? poll.endsAt);
  return Number.isFinite(ended) && now - ended < RESULTS_VISIBLE_MS;
}

// ------------------------------------------------------------------ predictions

export interface PredictionFrame {
  type: PredictionEventType;
  id: string;
  title: string;
  outcomes: PredictionViewDto["outcomes"];
  startedAt: string;
  locksAt: string | null;
  lockedAt: string | null;
  endedAt: string | null;
  winningOutcomeId: string | null;
  status: PredictionViewDto["status"];
}

export function parsePredictionFrame(type: string, data: unknown): PredictionFrame | null {
  const outcomes = (os: { id: string; title: string; channel_points: number; users: number }[]) =>
    os.map((o) => ({ id: o.id, title: o.title, points: o.channel_points, users: o.users }));
  const base = { lockedAt: null, endedAt: null, winningOutcomeId: null, locksAt: null };
  switch (type) {
    case "channel.prediction.begin":
    case "channel.prediction.progress": {
      const p = EVENTS[type].payload.safeParse(data);
      if (!p.success) return null;
      const { id, title, started_at, locks_at } = p.data;
      return {
        ...base,
        type,
        id,
        title,
        outcomes: outcomes(p.data.outcomes),
        startedAt: started_at,
        locksAt: locks_at,
        status: "active",
      };
    }
    case "channel.prediction.lock": {
      const p = EVENTS[type].payload.safeParse(data);
      if (!p.success) return null;
      const { id, title, started_at, locked_at } = p.data;
      return {
        ...base,
        type,
        id,
        title,
        outcomes: outcomes(p.data.outcomes),
        startedAt: started_at,
        lockedAt: locked_at,
        status: "locked",
      };
    }
    case "channel.prediction.end": {
      const p = EVENTS[type].payload.safeParse(data);
      if (!p.success) return null;
      return {
        ...base,
        type,
        id: p.data.id,
        title: p.data.title,
        outcomes: outcomes(p.data.outcomes),
        startedAt: p.data.started_at,
        endedAt: p.data.ended_at,
        winningOutcomeId: p.data.winning_outcome_id,
        status: p.data.status,
      };
    }
    default:
      return null;
  }
}

const PREDICTION_ORDER: Record<PredictionViewDto["status"], number> = {
  active: 0,
  locked: 1,
  resolved: 2,
  canceled: 2,
};

/** Apply a prediction frame; the viewer's bet is kept (its payout comes from refetching `current`). */
export function applyPredictionFrame(current: PredictionViewDto | null, f: PredictionFrame): PredictionViewDto {
  const same = current?.id === f.id ? current : null;
  // Frames can arrive out of order across instances: never move back from locked or ended.
  if (same && PREDICTION_ORDER[same.status] > PREDICTION_ORDER[f.status]) return same;
  return {
    id: f.id,
    title: f.title,
    outcomes: f.outcomes,
    status: f.status,
    startedAt: f.startedAt,
    locksAt: f.locksAt ?? same?.locksAt ?? f.lockedAt ?? f.startedAt,
    lockedAt: f.lockedAt ?? same?.lockedAt ?? null,
    endedAt: f.endedAt,
    winningOutcomeId: f.winningOutcomeId,
    myBet: same?.myBet ?? null,
  };
}

export function predictionVisible(p: PredictionViewDto | null, now: number): p is PredictionViewDto {
  if (!p) return false;
  if (p.status === "active" || p.status === "locked") return true;
  const ended = Date.parse(p.endedAt ?? p.locksAt);
  return Number.isFinite(ended) && now - ended < RESULTS_VISIBLE_MS;
}

/**
 * The bet amount field: a whole number from 1 to the smaller of the viewer's balance and the
 * router's 250,000. Null when the text is not such a number.
 */
export function betAmount(text: string, balance: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  const max = Math.min(MAX_BET_POINTS, Math.max(0, balance));
  return n >= 1 && n <= max ? n : null;
}

// ------------------------------------------------------------------ raids

export interface RaidFrame {
  raidId: string;
  status: "pending" | "completed" | "canceled";
  to: string;
  toDisplayName: string;
  executeAt: string;
}

export interface RaidBannerState {
  raidId: string;
  to: string;
  toDisplayName: string;
  executeAt: string;
}

/**
 * What an outgoing-raid frame does on the source channel's page: show the countdown, drop it,
 * or follow the raid to the target. The broadcaster's own page never navigates away.
 */
export function raidStep(
  banner: RaidBannerState | null,
  frame: RaidFrame,
  isBroadcaster: boolean,
): { banner: RaidBannerState | null; navigateTo: string | null } {
  switch (frame.status) {
    case "pending":
      return {
        banner: { raidId: frame.raidId, to: frame.to, toDisplayName: frame.toDisplayName, executeAt: frame.executeAt },
        navigateTo: null,
      };
    case "canceled":
      return { banner: banner?.raidId === frame.raidId ? null : banner, navigateTo: null };
    case "completed":
      return { banner: null, navigateTo: isBroadcaster ? null : frame.to };
  }
}
