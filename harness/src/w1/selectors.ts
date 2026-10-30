// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The W1 web ↔ harness contract (docs/testing/w1-selectors.md): routes and the `data-testid`s the
 * W1 scenario steps select by. A unit test checks every id here against the document. Owned by
 * the orchestrator: units send a contract request instead of editing it.
 */
import { INTERNAL_ROUTES } from "@commonair/contracts/internal";
import type { Locator, Page } from "playwright";

export const W1_TEST_IDS = {
  // Studio nav
  studioChatLink: "studio-chat-link",
  // Breakdown
  breakdownOpen: "breakdown-open",
  breakdownDialog: "breakdown-dialog",
  breakdownGross: "breakdown-gross",
  breakdownLine: "breakdown-line",
  breakdownHold: "breakdown-hold",
  breakdownCutSource: "breakdown-cut-source",
  breakdownTimelineItem: "breakdown-timeline-item",
  breakdownEstimate: "breakdown-estimate",
  feeSchedule: "fee-schedule",
  feeScheduleRow: "fee-schedule-row",
  // Calm Chat
  calmToggle: "calm-toggle",
  calmDigest: "calm-digest",
  chatWave: "chat-wave",
  chatWaveExpand: "chat-wave-expand",
  chatReportWave: "chat-report-wave",
  chatMessageActions: "chat-message-actions",
  chatUserBlock: "chat-user-block",
  blockedUsers: "blocked-users",
  blockedUser: "blocked-user",
  blockedUserRemove: "blocked-user-remove",
  chatReplayDisclosure: "chat-replay-disclosure",
  chatMessage: "chat-message",
  // Watch gate
  chatGateSettings: "chat-gate-settings",
  chatGateSeconds: "chat-gate-seconds",
  chatGateExemptSubs: "chat-gate-exempt-subs",
  surgeGuardEnabled: "surge-guard-enabled",
  surgeGuardRatio: "surge-guard-ratio",
  surgeGuardCooldown: "surge-guard-cooldown",
  chatGateSave: "chat-gate-save",
  surgeBanner: "surge-banner",
  surgeEnd: "surge-end",
  surgeStart: "surge-start",
  chatGateHint: "chat-gate-hint",
  // Fraud floor
  fraudFlags: "fraud-flags",
  fraudFlag: "fraud-flag",
  fraudFlagReview: "fraud-flag-review",
  fraudFlagDecide: "fraud-flag-decide",
  fraudFlagRaise: "fraud-flag-raise",
  fraudDecisionClear: "fraud-decision-clear",
  fraudDecisionConfirm: "fraud-decision-confirm",
  treasuryTabFraud: "treasury-tab-fraud",
  fraudFlagEvidence: "fraud-flag-evidence",
  fraudFlagHeld: "fraud-flag-held",
  fraudFlagConfirmed: "fraud-flag-confirmed",
  fraudFlagActionHint: "fraud-flag-action-hint",
  fraudReviewDialog: "fraud-review-dialog",
  fraudDecideDialog: "fraud-decide-dialog",
  fraudDecision: "fraud-decision",
  fraudNote: "fraud-note",
  fraudRaiseForm: "fraud-raise-form",
  fraudRaiseUsername: "fraud-raise-username",
  // Data mode
  dataModeToggle: "data-mode-toggle",
  dataModeBudget: "data-mode-budget",
  dataModeBudget50: "data-mode-budget-50",
  dataModeBudget800: "data-mode-budget-800",
  dataModeBudget1900: "data-mode-budget-1900",
  dataModeBudgetCustom: "data-mode-budget-custom",
  dataUsage: "data-usage",
  dataModeEstimate: "data-mode-estimate",
  dataModeNotice: "data-mode-notice",
  player: "player",
} as const;

export type W1TestId = (typeof W1_TEST_IDS)[keyof typeof W1_TEST_IDS];

/** An option item: `<field>-<value>` (spec "Rules"), e.g. `data-mode-budget-50`. */
export function w1Option(fieldId: string, value: string): string {
  return `${fieldId}-${value}`;
}

export const W1_ROUTES = {
  chatSettings: "/chat",
  privacy: "/settings/privacy",
  transparency: "/transparency",
  revenue: "/revenue",
  subscriptions: "/settings/subscriptions",
  treasury: "/treasury",
  /** The channel page with the player seam's diagnostic parameters (`timeline-sync` step 2, `surge-guard` step 5). */
  channel: (slug: string, diag: { targetLatency?: number; rendition?: string } = {}) => {
    const q = new URLSearchParams();
    if (diag.targetLatency !== undefined) q.set("targetLatency", String(diag.targetLatency));
    if (diag.rendition !== undefined) q.set("rendition", diag.rendition);
    const qs = q.toString();
    return qs ? `/${slug}?${qs}` : `/${slug}`;
  },
} as const;

/** Every route the W1 document's "Routes" table lists (first-column code spans, in order). */
export const W1_ROUTE_PATTERNS = [
  "/chat",
  "/settings/privacy",
  "/transparency",
  "/revenue",
  "/settings/subscriptions",
  "/treasury",
] as const;

/** Test hook (spec "Rules"): `POST` `{ job }` runs one `OPS_TICK_JOBS` job now. */
export const W1_OPS_TICK = INTERNAL_ROUTES.opsTick;

/** The ops jobs W1 adds to the hook (spec "Rules"). */
export const W1_OPS_JOBS = ["chat-retention", "chat-surge-guard", "money-reconcile", "money-fraud-scan"] as const;

function cssEscape(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** CSS selector for a test id with optional `data-*` constraints. */
export function w1tid(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${cssEscape(v)}"]`)
    .join("");
  return `[data-testid="${cssEscape(id)}"]${attrs}`;
}

export function byW1Id(scope: Page | Locator, id: string, data?: Record<string, string>): Locator {
  return scope.locator(w1tid(id, data));
}
