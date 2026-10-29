// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat panel's interactivity state for one channel: the current poll and prediction (loaded
 * on join, then kept current by event frames), the viewer's points (on join, after their own
 * votes and bets, and every 60 s) and the outgoing-raid banner. The panel feeds it frames from
 * its `ChatConnection` and renders what it returns.
 */
import * as React from "react";
import type { ChatRaidFrame } from "../connection.ts";
import type { InteractClient } from "./client.ts";
import {
  POINTS_REFRESH_MS,
  RESULTS_VISIBLE_MS,
  applyPollFrame,
  applyPredictionFrame,
  pollVisible,
  predictionVisible,
  raidStep,
  routeEventFrame,
  type LoyaltyBalanceDto,
  type PollFrame,
  type PollViewDto,
  type PredictionFrame,
  type PredictionViewDto,
  type RaidBannerState,
} from "./state.ts";

export interface ChatInteractOptions {
  channel: string;
  signedIn: boolean;
  selfUsername: string | null;
  client: InteractClient;
  /** Follow a completed raid to `/<to>` (the router, not a full reload). */
  onFollowRaid: (to: string) => void;
}

export interface ChatInteract {
  poll: PollViewDto | null;
  prediction: PredictionViewDto | null;
  points: LoyaltyBalanceDto | null;
  raid: RaidBannerState | null;
  /** True when the frame belonged to a card (handled or dropped); false sends it to the log. */
  onEvent: (type: string, data: unknown) => boolean;
  onRaid: (frame: ChatRaidFrame) => void;
  setPoll: (poll: PollViewDto) => void;
  setPrediction: (prediction: PredictionViewDto) => void;
  refreshPoints: () => void;
}

interface InteractState {
  poll: PollViewDto | null;
  prediction: PredictionViewDto | null;
  points: LoyaltyBalanceDto | null;
  raid: RaidBannerState | null;
}

type InteractAction =
  | { type: "reset" }
  | { type: "resetPoints" }
  | { type: "pollLoaded"; poll: PollViewDto | null }
  | { type: "predictionLoaded"; prediction: PredictionViewDto | null }
  | { type: "poll"; poll: PollViewDto }
  | { type: "prediction"; prediction: PredictionViewDto | null }
  | { type: "pollFrame"; frame: PollFrame }
  | { type: "predictionFrame"; frame: PredictionFrame }
  | { type: "points"; points: LoyaltyBalanceDto }
  | { type: "raid"; raid: RaidBannerState | null };

const EMPTY: InteractState = { poll: null, prediction: null, points: null, raid: null };

function interactReducer(state: InteractState, action: InteractAction): InteractState {
  switch (action.type) {
    case "reset":
      return { ...EMPTY, points: state.points };
    case "resetPoints":
      return state.points === null ? state : { ...state, points: null };
    case "pollLoaded": {
      // A frame may have landed first: keep its counts, take the viewer's vote from the call.
      const cur = state.poll;
      const p = action.poll;
      const poll = cur && p && cur.id === p.id ? { ...cur, myVote: p.myVote, myVotes: p.myVotes } : (cur ?? p);
      return { ...state, poll };
    }
    case "predictionLoaded": {
      const cur = state.prediction;
      const p = action.prediction;
      return { ...state, prediction: cur && p && cur.id === p.id ? { ...cur, myBet: p.myBet } : (cur ?? p) };
    }
    case "poll":
      return { ...state, poll: action.poll };
    case "prediction":
      return { ...state, prediction: action.prediction };
    case "pollFrame":
      return { ...state, poll: applyPollFrame(state.poll, action.frame) };
    case "predictionFrame":
      return { ...state, prediction: applyPredictionFrame(state.prediction, action.frame) };
    case "points":
      return { ...state, points: action.points };
    case "raid":
      return { ...state, raid: action.raid };
  }
}

export function useChatInteract({
  channel,
  signedIn,
  selfUsername,
  client,
  onFollowRaid,
}: ChatInteractOptions): ChatInteract {
  const [state, dispatch] = React.useReducer(interactReducer, EMPTY);
  const [now, setNow] = React.useState(() => Date.now());
  const self = selfUsername?.toLowerCase() ?? null;
  const isBroadcaster = self !== null && self === channel.toLowerCase();
  // Handlers outlive renders (the connection keeps them), so they read these through a ref.
  const live = React.useRef({ channel, client, onFollowRaid, isBroadcaster, raid: state.raid });
  React.useEffect(() => {
    live.current = { channel, client, onFollowRaid, isBroadcaster, raid: state.raid };
  });

  const refreshPrediction = React.useCallback(() => {
    const { client: c, channel: ch } = live.current;
    c.predictionCurrent(ch).then(
      (prediction) => {
        if (live.current.channel === ch) dispatch({ type: "prediction", prediction });
      },
      () => undefined,
    );
  }, []);

  const refreshPoints = React.useCallback(() => {
    const { client: c, channel: ch } = live.current;
    if (!signedIn || !self) return;
    c.balance(ch, self).then(
      (points) => {
        if (live.current.channel === ch) dispatch({ type: "points", points });
      },
      () => undefined,
    );
  }, [signedIn, self]);

  // On join (and channel switch): the current poll and prediction.
  React.useEffect(() => {
    dispatch({ type: "reset" });
    let gone = false;
    client.pollCurrent(channel).then(
      (poll) => {
        if (!gone) dispatch({ type: "pollLoaded", poll });
      },
      () => undefined,
    );
    client.predictionCurrent(channel).then(
      (prediction) => {
        if (!gone) dispatch({ type: "predictionLoaded", prediction });
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
    // `signedIn` changes who `myVote`/`myBet` describe, so reload with it.
  }, [channel, client, signedIn]);

  // The points chip: on join, then every minute. The ref is current before this runs (effects
  // run in order), so the first refresh asks about this channel.
  React.useEffect(() => {
    dispatch({ type: "resetPoints" });
    if (!signedIn || !self) return;
    refreshPoints();
    const timer = setInterval(refreshPoints, POINTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [channel, signedIn, self, refreshPoints]);

  // An ended card leaves after RESULTS_VISIBLE_MS; tick only while one is showing results.
  const { poll, prediction } = state;
  const showingResults =
    (poll !== null && poll.status !== "active") ||
    (prediction !== null && (prediction.status === "resolved" || prediction.status === "canceled"));
  React.useEffect(() => {
    if (!showingResults) return;
    const timer = setInterval(() => setNow(Date.now()), Math.min(5_000, RESULTS_VISIBLE_MS));
    return () => clearInterval(timer);
  }, [showingResults]);

  const onEvent = React.useCallback(
    (type: string, data: unknown): boolean => {
      const routed = routeEventFrame(type, data);
      if (routed.kind === "row") return false;
      if (routed.kind === "poll") dispatch({ type: "pollFrame", frame: routed.frame });
      else if (routed.kind === "prediction") {
        dispatch({ type: "predictionFrame", frame: routed.frame });
        // The payout (or refund) is the viewer's own; only `current` knows it.
        if (routed.frame.type === "channel.prediction.end") {
          refreshPrediction();
          refreshPoints();
        }
      }
      return true;
    },
    [refreshPrediction, refreshPoints],
  );

  const onRaid = React.useCallback((frame: ChatRaidFrame) => {
    const step = raidStep(live.current.raid, frame, live.current.isBroadcaster);
    live.current.raid = step.banner;
    dispatch({ type: "raid", raid: step.banner });
    if (step.navigateTo) live.current.onFollowRaid(step.navigateTo);
  }, []);

  const setPoll = React.useCallback((p: PollViewDto) => dispatch({ type: "poll", poll: p }), []);
  const setPrediction = React.useCallback(
    (p: PredictionViewDto) => dispatch({ type: "prediction", prediction: p }),
    [],
  );

  // `now` moves only while results show: a card that ended long before the panel mounted is
  // hidden at once, one that ends later leaves within a tick of RESULTS_VISIBLE_MS.
  return {
    poll: pollVisible(poll, now) ? poll : null,
    prediction: predictionVisible(prediction, now) ? prediction : null,
    points: signedIn && state.points?.enabled ? state.points : null,
    raid: state.raid,
    onEvent,
    onRaid,
    setPoll,
    setPrediction,
    refreshPoints,
  };
}
