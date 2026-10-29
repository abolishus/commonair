// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Viewer-side interactivity (E8): the poll and prediction cards pinned above the chat log and
 * the goal bars of the OBS goals overlay. Every string is a prop; the app owns state and calls.
 */
export {
  ViewerPollCard,
  type ViewerPollCardProps,
  type ViewerPollChoice,
  type ViewerPollExtra,
  type ViewerPollStatus,
} from "./poll-card.tsx";
export {
  ViewerPredictionCard,
  type ViewerPredictionAmount,
  type ViewerPredictionCardProps,
  type ViewerPredictionOutcome,
  type ViewerPredictionStatus,
} from "./prediction-card.tsx";
export {
  GoalBar,
  OverlayGoalsView,
  type GoalBarItem,
  type GoalBarProps,
  type GoalBarType,
  type OverlayGoalsViewProps,
} from "./goal-bar.tsx";
export { ShareBar, type ShareBarProps } from "./share-bar.tsx";
export { percentOf, useThrottledValue } from "./throttle.ts";
