// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The E8 web ↔ harness contract (docs/testing/e8-selectors.md): routes and the `data-testid`s the
 * E8 scenario steps select by. A unit test checks every id here against the document. Owned by
 * the orchestrator: units send a contract request instead of editing it.
 */
import { INTERNAL_ROUTES } from "@commonair/contracts/internal";
import type { Locator, Page } from "playwright";

export const E8_TEST_IDS = {
  // Studio nav
  studioInteractLink: "studio-interact-link",
  studioBotLink: "studio-bot-link",
  // /interact: polls
  interact: "interact",
  interactLoadError: "interact-load-error",
  interactRetry: "interact-retry",
  pollAddChoice: "poll-add-choice",
  pollArchive: "poll-archive",
  pollDuration: "poll-duration",
  pollEnd: "poll-end",
  pollExtraCost: "poll-extra-cost",
  pollForm: "poll-form",
  pollLive: "poll-live",
  pollLiveChoice: "poll-live-choice",
  pollStart: "poll-start",
  pollTitle: "poll-title",
  // /interact: predictions
  predictionAddOutcome: "prediction-add-outcome",
  predictionCancel: "prediction-cancel",
  predictionForm: "prediction-form",
  predictionLive: "prediction-live",
  predictionLiveOutcome: "prediction-live-outcome",
  predictionLock: "prediction-lock",
  predictionStart: "prediction-start",
  predictionTitle: "prediction-title",
  predictionWindow: "prediction-window",
  // /interact: raids
  raidCancel: "raid-cancel",
  raidCooldown: "raid-cooldown",
  raidError: "raid-error",
  raidForm: "raid-form",
  raidLast: "raid-last",
  raidPending: "raid-pending",
  raidPolicy: "raid-policy",
  raidPolicyAnyone: "raid-policy-anyone",
  raidPolicyFollowed: "raid-policy-followed",
  raidPolicyOff: "raid-policy-off",
  raidStart: "raid-start",
  raidTarget: "raid-target",
  // /interact: goals
  goalEnd: "goal-end",
  goalForm: "goal-form",
  goalRow: "goal-row",
  goalStart: "goal-start",
  goalTarget: "goal-target",
  goalTitle: "goal-title",
  goalType: "goal-type",
  goalTypeFollowers: "goal-type-followers",
  goalTypeSubscriptions: "goal-type-subscriptions",
  goalTypeTips: "goal-type-tips",
  // /bot
  bot: "bot",
  botAccount: "bot-account",
  botDisplayName: "bot-display-name",
  botEnabled: "bot-enabled",
  botFilterCaps: "bot-filter-caps",
  botFilterLinks: "bot-filter-links",
  botFilterSpam: "bot-filter-spam",
  botFilterTimeout: "bot-filter-timeout",
  botLoadError: "bot-load-error",
  botPointsEnabled: "bot-points-enabled",
  botPointsName: "bot-points-name",
  botRetry: "bot-retry",
  botSave: "bot-save",
  botSettings: "bot-settings",
  botSrEnabled: "bot-sr-enabled",
  botSrMax: "bot-sr-max",
  commandAliases: "command-aliases",
  commandCooldown: "command-cooldown",
  commandCost: "command-cost",
  commandEdit: "command-edit",
  commandEmpty: "command-empty",
  commandEnabled: "command-enabled",
  commandError: "command-error",
  commandForm: "command-form",
  commandLevel: "command-level",
  commandName: "command-name",
  commandNew: "command-new",
  commandRemove: "command-remove",
  commandResponse: "command-response",
  commandRow: "command-row",
  commandSave: "command-save",
  pointsAdjust: "points-adjust",
  pointsAdjustDelta: "points-adjust-delta",
  pointsAdjustOpen: "points-adjust-open",
  pointsAdjustReason: "points-adjust-reason",
  pointsAdjustSubmit: "points-adjust-submit",
  pointsAdjustUser: "points-adjust-user",
  pointsLeaderboard: "points-leaderboard",
  pointsRow: "points-row",
  srEmpty: "sr-empty",
  srPlayed: "sr-played",
  srRow: "sr-row",
  srSkip: "sr-skip",
  timerEdit: "timer-edit",
  timerEmpty: "timer-empty",
  timerEnabled: "timer-enabled",
  timerForm: "timer-form",
  timerInterval: "timer-interval",
  timerMessage: "timer-message",
  timerMinLines: "timer-min-lines",
  timerName: "timer-name",
  timerNew: "timer-new",
  timerRemove: "timer-remove",
  timerRow: "timer-row",
  timerSave: "timer-save",
  variableForm: "variable-form",
  variableName: "variable-name",
  variableRow: "variable-row",
  variableSave: "variable-save",
  variableValue: "variable-value",
  // /$channel chat panel
  chatEvent: "chat-event",
  chatPoints: "chat-points",
  chatPoll: "chat-poll",
  chatPollChoice: "chat-poll-choice",
  chatPollExtra: "chat-poll-extra",
  chatPollVoted: "chat-poll-voted",
  chatPrediction: "chat-prediction",
  chatPredictionAmount: "chat-prediction-amount",
  chatPredictionMyBet: "chat-prediction-my-bet",
  chatPredictionOutcome: "chat-prediction-outcome",
  raidBanner: "raid-banner",
  // Overlays
  overlayChat: "overlay-chat",
  overlayChatMessage: "overlay-chat-message",
  overlayGoal: "overlay-goal",
  overlayGoals: "overlay-goals",
} as const;

export type E8TestId = (typeof E8_TEST_IDS)[keyof typeof E8_TEST_IDS];

/** An option item: `<field>-<value>` (spec "Rules"), e.g. `raid-policy-off`. */
export function e8Option(fieldId: string, value: string): string {
  return `${fieldId}-${value}`;
}

/** Per-item ids the spec writes as patterns; each template is a code span in the document. */
export const E8_ID_PATTERNS = {
  pollChoice: { template: "poll-choice-<n>", id: (n: string) => `poll-choice-${n}` },
  predictionOutcome: { template: "prediction-outcome-<n>", id: (n: string) => `prediction-outcome-${n}` },
  predictionResolve: {
    template: "prediction-resolve-<outcomeId>",
    id: (outcomeId: string) => `prediction-resolve-${outcomeId}`,
  },
  chatPredictionBet: {
    template: "chat-prediction-bet-<outcomeId>",
    id: (outcomeId: string) => `chat-prediction-bet-${outcomeId}`,
  },
  commandLevel: { template: "command-level-<level>", id: (level: string) => e8Option("command-level", level) },
  pointsAdjustReason: {
    template: "points-adjust-reason-<reason>",
    id: (reason: string) => e8Option("points-adjust-reason", reason),
  },
} as const;

export const E8_ROUTES = {
  interact: "/interact",
  bot: "/bot",
  channel: (slug: string) => `/${slug}`,
  overlayGoals: "/overlay/goals",
  overlayChat: "/overlay/chat",
} as const;

/** Every route the E8 document's "Routes" table lists (first-column code spans, in order). */
export const E8_ROUTE_PATTERNS = ["/interact", "/bot", "/$channel", "/overlay/goals", "/overlay/chat"] as const;

/** Test hook (spec "Rules"): `POST` `{ job }` runs one `INTERACT_JOBS` job now. */
export const E8_INTERACT_TICK = INTERNAL_ROUTES.interactTick;

function cssEscape(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** CSS selector for a test id with optional `data-*` constraints. */
export function e8tid(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${cssEscape(v)}"]`)
    .join("");
  return `[data-testid="${cssEscape(id)}"]${attrs}`;
}

export function byE8Id(scope: Page | Locator, id: string, data?: Record<string, string>): Locator {
  return scope.locator(e8tid(id, data));
}
