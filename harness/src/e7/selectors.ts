// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The E7 web ↔ harness contract (docs/testing/e7-selectors.md): routes and the `data-testid`s the
 * E7 scenario steps select by. A unit test checks every id here against the document. Owned by
 * the orchestrator: units send a contract request instead of editing it.
 */
import type { Locator, Page } from "playwright";

export const E7_TEST_IDS = {
  // /dmca
  dmcaForm: "dmca-form",
  dmcaName: "dmca-name",
  dmcaEmail: "dmca-email",
  dmcaAddress: "dmca-address",
  dmcaPhone: "dmca-phone",
  dmcaWork: "dmca-work",
  dmcaUrls: "dmca-urls",
  dmcaGoodFaith: "dmca-good-faith",
  dmcaAccuracy: "dmca-accuracy",
  dmcaSignature: "dmca-signature",
  dmcaAltcha: "dmca-altcha",
  dmcaSubmit: "dmca-submit",
  dmcaReceipt: "dmca-receipt",
  footerDmcaLink: "footer-dmca-link",
  // /settings/copyright
  accountCopyrightLink: "account-copyright-link",
  copyright: "copyright",
  copyrightEmpty: "copyright-empty",
  copyrightNotice: "copyright-notice",
  copyrightItem: "copyright-item",
  counterOpen: "counter-open",
  counterForm: "counter-form",
  counterName: "counter-name",
  counterAddress: "counter-address",
  counterPhone: "counter-phone",
  counterStatement: "counter-statement",
  counterGoodFaith: "counter-good-faith",
  counterJurisdiction: "counter-jurisdiction",
  counterSignature: "counter-signature",
  counterSubmit: "counter-submit",
  counterReceipt: "counter-receipt",
  // /admin/dmca
  dmcaq: "dmcaq",
  dmcaqStatus: "dmcaq-status",
  dmcaqEmpty: "dmcaq-empty",
  dmcaqItem: "dmcaq-item",
  dmcaqDetail: "dmcaq-detail",
  dmcaqItemRow: "dmcaq-item-row",
  dmcaqStrikes: "dmcaq-strikes",
  dmcaqDecision: "dmcaq-decision",
  dmcaqDecisionActioned: "dmcaq-decision-actioned",
  dmcaqDecisionRejected: "dmcaq-decision-rejected",
  dmcaqNote: "dmcaq-note",
  dmcaqSubmit: "dmcaq-submit",
  dmcaqCounter: "dmcaq-counter",
  dmcaqSuitNote: "dmcaq-suit-note",
  dmcaqSuitFiled: "dmcaq-suit-filed",
  // /$channel held messages
  heldQueueOpen: "held-queue-open",
  heldQueue: "held-queue",
  heldQueueEmpty: "held-queue-empty",
  heldMessage: "held-message",
  heldAllow: "held-allow",
  heldDeny: "held-deny",
  chatMessage: "chat-message",
  // /settings/appeals account actions
  accountAction: "account-action",
  accountActionAppealOpen: "account-action-appeal-open",
  accountAppealDialog: "account-appeal-dialog",
  accountAppealBody: "account-appeal-body",
  accountAppealSubmit: "account-appeal-submit",
  appealRow: "appeal-row",
  // /admin/integrity
  integrityq: "integrityq",
  integrityqSubject: "integrityq-subject",
  integrityqDecision: "integrityq-decision",
  integrityqChannel: "integrityq-channel",
  integrityqEmpty: "integrityq-empty",
  integrityqItem: "integrityq-item",
  integrityqDecide: "integrityq-decide",
  integrityqDecideExcluded: "integrityq-decide-excluded",
  integrityqDecideAllowed: "integrityq-decide-allowed",
  integrityqReason: "integrityq-reason",
  integrityqSubmit: "integrityq-submit",
  // /admin/egress
  egress: "egress",
  egressFrom: "egress-from",
  egressTo: "egress-to",
  egressLoad: "egress-load",
  egressEmpty: "egress-empty",
  egressError: "egress-error",
  egressTotal: "egress-total",
  egressRow: "egress-row",
  // /admin/incidents
  incidents: "incidents",
  incidentsEmpty: "incidents-empty",
  incidentNew: "incident-new",
  incidentRow: "incident-row",
  incidentEdit: "incident-edit",
  incidentForm: "incident-form",
  incidentTitle: "incident-title",
  incidentStatus: "incident-status",
  incidentComponents: "incident-components",
  incidentBody: "incident-body",
  incidentSubmit: "incident-submit",
  // /coop/membership, /coop/council
  membershipRejoinViewer: "membership-rejoin-viewer",
  coopLoadError: "coop-load-error",
  coopRetry: "coop-retry",
  electionItem: "election-item",
  electionNominate: "election-nominate",
  electionNominateStatement: "election-nominate-statement",
  electionNominateSubmit: "election-nominate-submit",
  electionCandidate: "election-candidate",
  electionBallot: "election-ballot",
  electionBallotSubmit: "election-ballot-submit",
  electionVoted: "election-voted",
  // Legal
  legalPending: "legal-pending",
  legalPendingAccept: "legal-pending-accept",
} as const;

export type E7TestId = (typeof E7_TEST_IDS)[keyof typeof E7_TEST_IDS];

/** An option item: `<field>-<value>` (spec "Rules"), e.g. `dmcaq-status-received`. */
export function e7Option(fieldId: string, value: string): string {
  return `${fieldId}-${value}`;
}

/** Per-item ids the spec writes as patterns; each template is a code span in the document. */
export const E7_ID_PATTERNS = {
  dmcaqStatus: { template: "dmcaq-status-<status>", id: (status: string) => e7Option("dmcaq-status", status) },
  counterItem: { template: "counter-item-<itemId>", id: (itemId: string) => `counter-item-${itemId}` },
  integrityqSubject: {
    template: "integrityq-subject-<type>",
    id: (type: string) => e7Option("integrityq-subject", type),
  },
  integrityqDecision: {
    template: "integrityq-decision-<decision>",
    id: (decision: string) => e7Option("integrityq-decision", decision),
  },
  incidentStatus: { template: "incident-status-<status>", id: (status: string) => e7Option("incident-status", status) },
  electionBallot: {
    template: "election-ballot-<candidateId>",
    id: (candidateId: string) => `election-ballot-${candidateId}`,
  },
} as const;

export const E7_ROUTES = {
  dmca: "/dmca",
  copyright: "/settings/copyright",
  adminDmca: "/admin/dmca",
  adminIntegrity: "/admin/integrity",
  adminEgress: "/admin/egress",
  adminIncidents: "/admin/incidents",
  channel: (slug: string) => `/${slug}`,
  appeals: "/settings/appeals",
  coopMembership: "/coop/membership",
  coopCouncil: "/coop/council",
} as const;

/** Every route the E7 document's "Routes" table lists (first-column code spans, in order). */
export const E7_ROUTE_PATTERNS = [
  "/dmca",
  "/settings/copyright",
  "/admin/dmca",
  "/admin/integrity",
  "/admin/egress",
  "/admin/incidents",
  "/$channel",
  "/settings/appeals",
  "/coop/membership",
  "/coop/council",
] as const;

/** Test hook (spec "Rules"): `POST` `{ asOf }` runs `dmca-restore` once. */
export const E7_DMCA_TICK = "/internal/moderation/dmca-tick";

function cssEscape(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** CSS selector for a test id with optional `data-*` constraints. */
export function e7tid(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${cssEscape(v)}"]`)
    .join("");
  return `[data-testid="${cssEscape(id)}"]${attrs}`;
}

export function byE7Id(scope: Page | Locator, id: string, data?: Record<string, string>): Locator {
  return scope.locator(e7tid(id, data));
}
