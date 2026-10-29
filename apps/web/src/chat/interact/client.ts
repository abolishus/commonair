// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The calls the chat panel's poll, prediction and points controls make, behind one interface so
 * tests pass a fake. The browser's goes through the same-origin `/rpc` with the session cookie.
 */
import { api, errorCode } from "../../lib/api.ts";
import { errorRequirement } from "../../lib/coop.ts";
import type { MessageKey } from "../../i18n/index.ts";
import type { LoyaltyBalanceDto, PollViewDto, PredictionViewDto } from "./state.ts";

export interface InteractClient {
  pollCurrent(channel: string): Promise<PollViewDto | null>;
  vote(input: { id: string; choiceId: string; extraVotes: number }): Promise<PollViewDto>;
  predictionCurrent(channel: string): Promise<PredictionViewDto | null>;
  bet(input: { id: string; outcomeId: string; points: number }): Promise<PredictionViewDto>;
  balance(channel: string, username: string): Promise<LoyaltyBalanceDto>;
}

export function browserInteractClient(): InteractClient {
  const client = api();
  return {
    pollCurrent: (channel) => client.interact.polls.current({ channel }),
    vote: (input) => client.interact.polls.vote(input),
    predictionCurrent: (channel) => client.interact.predictions.current({ channel }),
    bet: (input) => client.interact.predictions.bet(input),
    balance: (channel, username) => client.bot.points.balance({ channel, username }),
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
      return "chatPrediction.error.staff";
    case "CONFLICT":
      return what === "poll" ? "chatPoll.error.closed" : "chatPrediction.error.closed";
    case "TOO_MANY_REQUESTS":
      return "chatPoints.error.slowDown";
    default:
      return what === "poll" ? "chatPoll.error.failed" : "chatPrediction.error.failed";
  }
}
