// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The E5 web ↔ harness contract (docs/testing/e5-selectors.md): the co-op routes and the
 * `data-testid`s the `e5-coop` scenario selects by. Kept beside the scenario (the shared
 * `web/selectors.ts` lists E1–E4c); a unit test checks every id here against the document.
 */
import type { Locator, Page } from "playwright";

export const E5_TEST_IDS = {
  coop: "coop",
  coopMembershipCard: "coop-membership-card",
  membership: "membership",
  membershipRow: "membership-row",
  membershipEligibility: "membership-eligibility",
  membershipShare: "membership-share",
  membershipBuyShare: "membership-buy-share",
  membershipShareInstructions: "membership-share-instructions",
  membershipExitConfirm: "membership-exit-confirm",
  proposals: "proposals",
  proposalItem: "proposal-item",
  proposalsNew: "proposals-new",
  proposalForm: "proposal-form",
  proposalTitle: "proposal-title",
  proposalBody: "proposal-body",
  proposalAffectsCreators: "proposal-affects-creators",
  proposalChangeAdd: "proposal-change-add",
  proposalChange: "proposal-change",
  proposalChangeKey: "proposal-change-key",
  proposalChangeValue: "proposal-change-value",
  proposalKind: "proposal-kind",
  proposalSave: "proposal-save",
  proposal: "proposal",
  proposalChangeSummary: "proposal-change-summary",
  proposalSubmit: "proposal-submit",
  votePanel: "vote-panel",
  voteChoice: "vote-choice",
  voteSubmit: "vote-submit",
  voteParticipation: "vote-participation",
  tally: "tally",
  tallyRow: "tally-row",
  tallyCheck: "tally-check",
  council: "council",
  councilMember: "council-member",
  settings: "settings",
  settingRow: "setting-row",
  statement: "statement",
  statementLine: "statement-line",
  statementLineExplanation: "statement-line-explanation",
  treasuryTabShares: "treasury-tab-shares",
  treasuryTabPatronage: "treasury-tab-patronage",
  treasuryShareRow: "treasury-share-row",
  treasuryShareRefund: "treasury-share-refund",
  treasuryShareRefundNote: "treasury-share-refund-note",
  treasuryShareRefundSubmit: "treasury-share-refund-submit",
  patronageRunForm: "patronage-run-form",
  patronageRunStart: "patronage-run-start",
  patronageRunEnd: "patronage-run-end",
  patronageRunSurplus: "patronage-run-surplus",
  patronageRunSubmit: "patronage-run-submit",
  patronageRunResult: "patronage-run-result",
  patronagePeriodRow: "patronage-period-row",
  patronageApprove: "patronage-approve",
  adminCoop: "admin-coop",
  appointWorkerUsername: "appoint-worker-username",
  appointWorkerMinute: "appoint-worker-minute",
  appointWorkerSubmit: "appoint-worker-submit",
  transparencyGovernance: "transparency-governance",
  transparencyPatronage: "transparency-patronage",
} as const;

/** Ids the document writes with a placeholder (`membership-exit-<class>`, `vote-choice-yes`, …). */
export const E5_TEMPLATED_IDS = {
  membershipExit: (cls: string) => `membership-exit-${cls}`,
  proposalChangeKeyItem: (key: string) => `proposal-change-key-${key}`,
  voteChoiceItem: (choice: string) => `vote-choice-${choice}`,
} as const;

/** Ids shared with earlier milestones that E5 flows use (E1 `confirm-dialog-confirm`, E4b `/treasury`). */
export const CONFIRM_DIALOG_CONFIRM = "confirm-dialog-confirm";
export const TREASURY = "treasury";

export const E5_ROUTES = {
  coop: "/coop",
  membership: "/coop/membership",
  proposals: "/coop/proposals",
  proposalNew: "/coop/proposals/new",
  proposal: (id: string) => `/coop/proposals/${encodeURIComponent(id)}`,
  council: "/coop/council",
  settings: "/coop/settings",
  patronage: "/coop/patronage",
  statement: (periodId: string) => `/coop/patronage/${encodeURIComponent(periodId)}`,
  treasury: "/treasury",
  adminCoop: "/admin/coop",
  transparency: "/transparency",
} as const;

/** Route patterns exactly as the E5 document's "Routes" table writes them. */
export const E5_ROUTE_PATTERNS = [
  "/coop",
  "/coop/membership",
  "/coop/proposals",
  "/coop/proposals/new",
  "/coop/proposals/$id",
  "/coop/council",
  "/coop/settings",
  "/coop/patronage",
  "/coop/patronage/$periodId",
  "/treasury",
  "/admin/coop",
  "/transparency",
] as const;

function cssEscape(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** CSS selector for a test id with optional `data-*` constraints. */
export function ctid(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${cssEscape(v)}"]`)
    .join("");
  return `[data-testid="${cssEscape(id)}"]${attrs}`;
}

export function byCoopId(scope: Page | Locator, id: string, data?: Record<string, string>): Locator {
  return scope.locator(ctid(id, data));
}
