// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The calls the chat panel's poll, prediction, giveaway and points controls make, behind one
 * interface so tests pass a fake. The browser's goes through the same-origin `/rpc` with the
 * session cookie.
 */
import { api, errorCode, type Api } from "../../lib/api.ts";
import { errorReason, errorRequirement } from "../../lib/coop.ts";
import type { MessageKey } from "../../i18n/index.ts";
import {
  playbackMode as clockPlaybackMode,
  playheadWallclock as clockPlayhead,
  type PlaybackMode,
} from "../../player/media-clock.ts";
import type { GiveawayDto, GoalDto, LoyaltyBalanceDto, PollViewDto, PredictionViewDto } from "./state.ts";

export interface BetInput {
  id: string;
  outcomeId: string;
  points: number;
  /**
   * Batch 7 decision (v): the bettor's playhead (`playheadWallclock()`, ISO 8601), so a bet placed
   * before the lock in what the viewer sees counts; null when unknown. `withPlayhead` fills it.
   */
  mediaTs?: string | null;
  /** A `dvr` (catching-up) session cannot bet. `withPlayhead` fills it; absent = `live`. */
  playbackMode?: PlaybackMode;
}

export interface InteractClient {
  pollCurrent(channel: string): Promise<PollViewDto | null>;
  vote(input: { id: string; choiceId: string; extraVotes: number }): Promise<PollViewDto>;
  predictionCurrent(channel: string): Promise<PredictionViewDto | null>;
  bet(input: BetInput): Promise<PredictionViewDto>;
  balance(channel: string, username: string): Promise<LoyaltyBalanceDto>;
  /** The open (or latest) giveaway; null with none, and always null while the instance has giveaways off. */
  giveawayCurrent(channel: string): Promise<GiveawayDto | null>;
  /** Enter a giveaway (one entry per account; free). */
  giveawayEnter(input: { id: string }): Promise<GiveawayDto>;
  /** The channel's goals (`interact.goals.list`, running and ended); absent: no goals in the strip. */
  goals?(channel: string): Promise<GoalDto[]>;
}

type InstanceClient = Pick<Api, "instance">;

// `instance.info().features.giveaways`, read once per client; a failure is not cached.
const giveawayFlags = new WeakMap<object, Promise<boolean>>();

/** GIVEAWAYS_ENABLED (batch 7 decision (a)): off, the web shows no giveaway surface and asks nothing. */
export function giveawaysEnabled(client: InstanceClient): Promise<boolean> {
  const hit = giveawayFlags.get(client);
  if (hit) return hit;
  const p = Promise.resolve()
    .then(() => client.instance.info())
    .then((i) => i.features.giveaways);
  giveawayFlags.set(client, p);
  p.catch(() => giveawayFlags.delete(client));
  return p;
}

export function browserInteractClient(): InteractClient {
  const client = api();
  return {
    pollCurrent: (channel) => client.interact.polls.current({ channel }),
    vote: (input) => client.interact.polls.vote(input),
    predictionCurrent: (channel) => client.interact.predictions.current({ channel }),
    bet: (input) => client.interact.predictions.bet(input),
    balance: (channel, username) => client.bot.points.balance({ channel, username }),
    giveawayCurrent: async (channel) =>
      (await giveawaysEnabled(client)) ? client.interact.giveaways.current({ channel }) : null,
    giveawayEnter: (input) => client.interact.giveaways.enter(input),
    goals: (channel) => client.interact.goals.list({ channel }),
  };
}

/** Where `withPlayhead` reads the player seam (`player/media-clock.ts`); tests pass a fake. */
export interface PlayheadClock {
  playheadWallclock(channel: string): Date | null;
  playbackMode(channel: string): PlaybackMode;
}

const MEDIA_CLOCK: PlayheadClock = { playheadWallclock: clockPlayhead, playbackMode: clockPlaybackMode };

/**
 * Batch 7 decision (v): every bet carries the playhead and playback mode of this channel's player
 * at the moment it is placed (the API judges the lock against what the viewer saw). A caller's own
 * values win.
 */
export function withPlayhead(
  client: InteractClient,
  channel: string,
  clock: PlayheadClock = MEDIA_CLOCK,
): InteractClient {
  return {
    ...client,
    bet: (input) =>
      client.bet({
        ...input,
        mediaTs:
          input.mediaTs !== undefined ? input.mediaTs : (clock.playheadWallclock(channel)?.toISOString() ?? null),
        playbackMode: input.playbackMode ?? clock.playbackMode(channel),
      }),
  };
}

/** A refused vote or bet as the viewer's message (never the server's English text). */
export function interactErrorKey(err: unknown, what: "poll" | "prediction"): MessageKey {
  const requirement = errorRequirement(err);
  if (requirement === "insufficient_points") return "chatPoints.insufficient";
  if (requirement === "points_disabled") return "chatPoints.disabled";
  switch (errorCode(err)) {
    case "UNAUTHORIZED":
      return what === "poll" ? "chatPoll.signIn" : "chatPrediction.signIn";
    case "FORBIDDEN":
      // Both a ban/timeout and (for bets) the channel's staff are FORBIDDEN; only a `staff`
      // reason earns the staff message, anything else stays neutral.
      if (what === "prediction" && isStaffRefusal(err)) return "chatPrediction.error.staff";
      return what === "poll" ? "chatPoll.error.forbidden" : "chatPrediction.error.forbidden";
    case "CONFLICT":
      return what === "poll" ? "chatPoll.error.closed" : "chatPrediction.error.closed";
    case "TOO_MANY_REQUESTS":
      return "chatPoints.error.slowDown";
    default:
      return what === "poll" ? "chatPoll.error.failed" : "chatPrediction.error.failed";
  }
}

/** A bet refused because the viewer is the channel's owner, an editor or a moderator. */
export function isStaffRefusal(err: unknown): boolean {
  return errorCode(err) === "FORBIDDEN" && errorReason(err) === "staff";
}
