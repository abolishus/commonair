// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web app ↔ harness contract from `docs/testing/e1-selectors.md`, `e2-selectors.md`,
 * `e3-selectors.md`, `e4b-selectors.md` and `e4c-selectors.md`: routes and `data-testid` values. Scenarios select only by these
 * ids (never by visible text, which is translated). A unit test parses the markdown tables and
 * fails when this module and any of the documents disagree.
 */

/** E1 ids (docs/testing/e1-selectors.md). */
export const E1_TEST_IDS = {
  signupEmail: "signup-email",
  signupUsername: "signup-username",
  signupPassword: "signup-password",
  signupBirthdate: "signup-birthdate",
  signupLegal: "signup-legal",
  signupAltcha: "signup-altcha",
  signupSubmit: "signup-submit",
  signupCheckEmail: "signup-check-email",
  formError: "form-error",
  signinEmail: "signin-email",
  signinPassword: "signin-password",
  signinSubmit: "signin-submit",
  navUser: "nav-user",
  streamServerUrl: "stream-server-url",
  streamKeyPrefix: "stream-key-prefix",
  streamKeyRotate: "stream-key-rotate",
  streamKey: "stream-key",
  streamKeyCopy: "stream-key-copy",
  confirmDialogConfirm: "confirm-dialog-confirm",
  channelLink: "channel-link",
  player: "player",
  playerVideo: "player-video",
  liveBadge: "live-badge",
  offlineState: "offline-state",
  chat: "chat",
  chatInput: "chat-input",
  chatSend: "chat-send",
  chatSigninPrompt: "chat-signin-prompt",
  chatMessage: "chat-message",
  footerSourceLink: "footer-source-link",
} as const;

/**
 * Ids E2 adds (docs/testing/e2-selectors.md). `chat-message` is listed there too (it gains
 * `data-id` / `data-deleted`), so the E2 table is checked against these plus `chatMessage`.
 */
export const E2_TEST_IDS = {
  navDirectory: "nav-directory",
  directory: "directory",
  directorySection: "directory-section",
  streamCard: "stream-card",
  channelCard: "channel-card",
  directoryEmpty: "directory-empty",
  followButton: "follow-button",
  followerCount: "follower-count",
  chatMessageActions: "chat-message-actions",
  chatModTimeout: "chat-mod-timeout",
  chatModBan: "chat-mod-ban",
  chatNotice: "chat-notice",
} as const;

/** E1 ids that the E2 document re-lists because E2 changes them. */
export const E2_CHANGED_E1_IDS = [E1_TEST_IDS.chatMessage] as const;

/** Ids E3 adds (docs/testing/e3-selectors.md). */
export const E3_TEST_IDS = {
  relaysLink: "relays-link",
  relays: "relays",
  relaysEmpty: "relays-empty",
  relayCreateName: "relay-create-name",
  relayCreateSubmit: "relay-create-submit",
  relayToken: "relay-token",
  relayRunCommand: "relay-run-command",
  relayRow: "relay-row",
  relayStatus: "relay-status",
  relayBytesVerified: "relay-bytes-verified",
  relayReceipts: "relay-receipts",
  relaySuspendedReason: "relay-suspended-reason",
  relayRemove: "relay-remove",
} as const;

/** E1 ids the E3 document re-lists: `player` gains `data-source`. */
export const E3_CHANGED_E1_IDS = [E1_TEST_IDS.player] as const;

/** E1 ids the E4b document re-lists: `chat-message` gains `data-badges`. */
export const E4B_CHANGED_E1_IDS = [E1_TEST_IDS.chatMessage] as const;

/**
 * Ids E4b adds (docs/testing/e4b-selectors.md), as listed in the first column of its tables. The
 * per-tier inputs `revenue-tier-<field>-<n>` are built by `revenueTierInput`.
 */
export const E4B_TEST_IDS = {
  revenueLink: "revenue-link",
  accountSubscriptionsLink: "account-subscriptions-link",
  accountTreasuryLink: "account-treasury-link",
  footerTransparencyLink: "footer-transparency-link",
  supportOpen: "support-open",
  supportDialog: "support-dialog",
  supportTabSub: "support-tab-sub",
  supportTabGift: "support-tab-gift",
  supportTabTip: "support-tab-tip",
  supportTier: "support-tier",
  supportCurrent: "support-current",
  supportGiftCount: "support-gift-count",
  supportGiftRecipient: "support-gift-recipient",
  supportGiftTo: "support-gift-to",
  supportTipAmount: "support-tip-amount",
  supportTipMessage: "support-tip-message",
  supportTipAnonymous: "support-tip-anonymous",
  supportSplit: "support-split",
  supportTotal: "support-total",
  supportSubmit: "support-submit",
  supportError: "support-error",
  supportInstructions: "support-instructions",
  chatEvent: "chat-event",
  subscriptions: "subscriptions",
  subscriptionsEmpty: "subscriptions-empty",
  subscriptionRow: "subscription-row",
  subscriptionCancel: "subscription-cancel",
  revenue: "revenue",
  revenueMonth: "revenue-month",
  revenueAvailable: "revenue-available",
  revenueHeld: "revenue-held",
  revenueOwed: "revenue-owed",
  revenueEarned: "revenue-earned",
  revenueSource: "revenue-source",
  revenueTierRow: "revenue-tier-row",
  revenueLedgerRow: "revenue-ledger-row",
  revenueLedgerMore: "revenue-ledger-more",
  revenueStatementCsv: "revenue-statement-csv",
  revenuePayoutAccount: "revenue-payout-account",
  revenueTiers: "revenue-tiers",
  revenueTiersSave: "revenue-tiers-save",
  treasury: "treasury",
  treasuryTabPayments: "treasury-tab-payments",
  treasuryTabPayouts: "treasury-tab-payouts",
  treasuryTabAccounts: "treasury-tab-accounts",
  treasuryTabCosts: "treasury-tab-costs",
  treasurySearch: "treasury-search",
  treasuryPaymentRow: "treasury-payment-row",
  treasuryConfirm: "treasury-confirm",
  treasuryRefund: "treasury-refund",
  treasuryChargeback: "treasury-chargeback",
  treasuryRunPayouts: "treasury-run-payouts",
  treasuryPayoutsResult: "treasury-payouts-result",
  treasuryPayoutRow: "treasury-payout-row",
  treasuryMarkPaid: "treasury-mark-paid",
  treasuryAccountUsername: "treasury-account-username",
  treasuryAccountReference: "treasury-account-reference",
  treasuryAccountEnabled: "treasury-account-enabled",
  treasuryAccountSubmit: "treasury-account-submit",
  treasuryCostCategory: "treasury-cost-category",
  treasuryCostDescription: "treasury-cost-description",
  treasuryCostAmount: "treasury-cost-amount",
  treasuryCostSubmit: "treasury-cost-submit",
  transparency: "transparency",
  transparencyStat: "transparency-stat",
  transparencyFlow: "transparency-flow",
  transparencyMonthRow: "transparency-month-row",
  transparencyEmpty: "transparency-empty",
} as const;

/** Ids the E4b document names inside another element's description (dialog parts, toggle items). */
export const E4B_NESTED_TEST_IDS = {
  supportGiftRecipientRandom: "support-gift-recipient-random",
  supportGiftRecipientViewer: "support-gift-recipient-viewer",
  supportReference: "support-reference",
  supportAmount: "support-amount",
  treasuryDisputeAmount: "treasury-dispute-amount",
  treasuryDisputeReason: "treasury-dispute-reason",
  treasuryDisputeSubmit: "treasury-dispute-submit",
  treasuryMarkPaidReference: "treasury-mark-paid-reference",
  treasuryMarkPaidSubmit: "treasury-mark-paid-submit",
} as const;

/**
 * Ids E4c adds (docs/testing/e4c-selectors.md, trust & safety), as listed in the first column of
 * its "Test ids" tables.
 */
export const E4C_TEST_IDS = {
  reportOpen: "report-open",
  reportDialog: "report-dialog",
  reportReason: "report-reason",
  reportDetails: "report-details",
  reportSubmit: "report-submit",
  matureGate: "mature-gate",
  streamRestricted: "stream-restricted",
  nciiForm: "ncii-form",
  nciiReceipt: "ncii-receipt",
  footerTakedownLink: "footer-takedown-link",
  appeals: "appeals",
  appealRow: "appeal-row",
  moderationLabelNotice: "moderation-label-notice",
  labelAppealDialog: "label-appeal-dialog",
  accountAppealsLink: "account-appeals-link",
  accountModerationLink: "account-moderation-link",
  modq: "modq",
  modqItem: "modq-item",
  modqDetail: "modq-detail",
  modqFrame: "modq-frame",
  modqFrameReveal: "modq-frame-reveal",
  modqNotScored: "modq-not-scored",
  modqHistory: "modq-history",
  modqDecision: "modq-decision",
  nciiDecision: "ncii-decision",
  appealqItem: "appealq-item",
  appealqResolve: "appealq-resolve",
  accountLegalLink: "account-legal-link",
  legalCase: "legal-case",
  legalEvidence: "legal-evidence",
  legalConfirm: "legal-confirm",
  legalDismiss: "legal-dismiss",
  legalNcmec: "legal-ncmec",
  legalHold: "legal-hold",
} as const;

/** Ids the E4c document names inside another element's description (fields, items, controls). */
export const E4C_NESTED_TEST_IDS = {
  matureGateConfirm: "mature-gate-confirm",
  matureGateSignin: "mature-gate-signin",
  streamRestrictedReveal: "stream-restricted-reveal",
  nciiName: "ncii-name",
  nciiEmail: "ncii-email",
  nciiRelationship: "ncii-relationship",
  nciiRelationshipSelf: "ncii-relationship-self",
  nciiRelationshipRepresentative: "ncii-relationship-representative",
  nciiUrls: "ncii-urls",
  nciiDescription: "ncii-description",
  nciiGoodFaith: "ncii-good-faith",
  nciiSignature: "ncii-signature",
  nciiSubmit: "ncii-submit",
  appealsEmpty: "appeals-empty",
  labelAppealOpen: "label-appeal-open",
  labelAppealBody: "label-appeal-body",
  labelAppealSubmit: "label-appeal-submit",
  modqTabCases: "modq-tab-cases",
  modqTabReports: "modq-tab-reports",
  modqTabNcii: "modq-tab-ncii",
  modqTabLabels: "modq-tab-labels",
  modqHistoryRow: "modq-history-row",
  modqDuration: "modq-duration",
  modqNote: "modq-note",
  modqSubmit: "modq-submit",
  nciiDecisionRemoved: "ncii-decision-removed",
  nciiDecisionRejected: "ncii-decision-rejected",
  nciiNote: "ncii-note",
  nciiDecideSubmit: "ncii-decide-submit",
  appealqResolveUpheld: "appealq-resolve-upheld",
  appealqResolveOverturned: "appealq-resolve-overturned",
  appealqResolution: "appealq-resolution",
  appealqSubmit: "appealq-submit",
  legalEvidenceView: "legal-evidence-view",
  legalEvidenceReveal: "legal-evidence-reveal",
  legalNcmecOpen: "legal-ncmec-open",
  legalNcmecReportId: "legal-ncmec-report-id",
  legalNcmecFiledAt: "legal-ncmec-filed-at",
  legalNcmecFile: "legal-ncmec-file",
} as const;

/** `modq-decision` items: `modq-decision-<decision>` for each `MODERATION_REVIEW_DECISIONS` value. */
export const MODQ_DECISIONS = ["clear", "warn", "end_stream", "suspend", "escalate_legal"] as const;
export type ModqDecision = (typeof MODQ_DECISIONS)[number];
export type ModqDecisionId = `modq-decision-${ModqDecision}`;
export function modqDecision(decision: ModqDecision): ModqDecisionId {
  return `modq-decision-${decision}`;
}

/** `report-reason` items: `report-reason-<reason>` for each `REPORT_REASONS` value. */
export type ReportReasonId = `report-reason-${string}`;
export function reportReason(reason: string): ReportReasonId {
  return `report-reason-${reason}`;
}

/** Fields of the tier editor: `revenue-tier-<field>-<n>` for n = 1–3. */
export const REVENUE_TIER_FIELDS = ["name", "price", "benefits"] as const;
export type RevenueTierField = (typeof REVENUE_TIER_FIELDS)[number];
export type RevenueTierInputId = `revenue-tier-${RevenueTierField}-${1 | 2 | 3}`;

export function revenueTierInput(field: RevenueTierField, tier: 1 | 2 | 3): RevenueTierInputId {
  return `revenue-tier-${field}-${tier}`;
}

export const TEST_IDS = {
  ...E1_TEST_IDS,
  ...E2_TEST_IDS,
  ...E3_TEST_IDS,
  ...E4B_TEST_IDS,
  ...E4B_NESTED_TEST_IDS,
  ...E4C_TEST_IDS,
  ...E4C_NESTED_TEST_IDS,
} as const;

/** `data-source` values of `player` (never `p2p`: that is a loader, not a playlist source). */
export const PLAYER_SOURCES = ["origin", "relay", "cdn"] as const;
export type PlayerSource = (typeof PLAYER_SOURCES)[number];

/** `data-section` values of `directory-section` whose cards are live `stream-card`s. */
export const LIVE_DIRECTORY_SECTIONS = ["spotlight", "new", "live", "following"] as const;
export type LiveDirectorySection = (typeof LIVE_DIRECTORY_SECTIONS)[number];
/** Sections of offline channels; their cards are `channel-card` links. */
export const OFFLINE_DIRECTORY_SECTIONS = ["following-offline", "recent"] as const;
/** Every `data-section` value of `directory-section`. */
export const DIRECTORY_SECTIONS = [...LIVE_DIRECTORY_SECTIONS, ...OFFLINE_DIRECTORY_SECTIONS] as const;
export type DirectorySection = (typeof DIRECTORY_SECTIONS)[number];

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS] | RevenueTierInputId | ModqDecisionId | ReportReasonId;

/** Route patterns exactly as the E1 document writes them (`$channel` = the channel slug). */
export const ROUTE_PATTERNS = ["/", "/signup", "/signin", "/dashboard", "/$channel", "/embed/$channel"] as const;

/** Routes the E2 document changes (a subset of ROUTE_PATTERNS: `/` is the directory now). */
export const E2_ROUTE_PATTERNS = ["/", "/$channel"] as const;

/** Routes the E3 document adds or changes (`/relays` is new). */
export const E3_ROUTE_PATTERNS = ["/relays", "/dashboard", "/$channel"] as const;

/** Routes the E4b document adds or changes. */
export const E4B_ROUTE_PATTERNS = [
  "/$channel",
  "/settings/subscriptions",
  "/revenue",
  "/treasury",
  "/transparency",
  "/dashboard",
] as const;

/** Routes the E4c document adds or changes. */
export const E4C_ROUTE_PATTERNS = [
  "/$channel",
  "/takedown",
  "/settings/appeals",
  "/dashboard",
  "/admin/moderation",
  "/admin/appeals",
  "/admin/legal",
] as const;

export const ROUTES = {
  home: "/",
  /** E2: `/` is the directory. */
  directory: "/",
  signup: "/signup",
  signin: "/signin",
  dashboard: "/dashboard",
  /** E3: your relays. */
  relays: "/relays",
  /** E4b: your subscriptions. */
  subscriptions: "/settings/subscriptions",
  /** E4b: the creator's revenue dashboard. */
  revenue: "/revenue",
  /** E4b: treasurers only. */
  treasury: "/treasury",
  /** E4b: public. */
  transparency: "/transparency",
  /** E4c: the public NCII takedown form. */
  takedown: "/takedown",
  /** E4c: your appeals and label notices. */
  appeals: "/settings/appeals",
  /** E4c: platform moderators, admins and `legal`. */
  adminModeration: "/admin/moderation",
  /** E4c: platform moderators. */
  adminAppeals: "/admin/appeals",
  /** E4c: `legal` only. */
  adminLegal: "/admin/legal",
  channel: (slug: string) => `/${encodeURIComponent(slug)}`,
  embed: (slug: string) => `/embed/${encodeURIComponent(slug)}`,
} as const;

/** CSS selector for a test id, optionally with attribute constraints (`{ state: "playing" }` → `[data-state="playing"]`). */
export function tid(id: TestId, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${cssEscapeString(v)}"]`)
    .join("");
  return `[data-testid="${id}"]${attrs}`;
}

function cssEscapeString(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Absolute URL of the web app's embed route for a channel (what `--player web` opens). */
export function webEmbedUrl(webUrl: string, channel: string): string {
  return new URL(ROUTES.embed(channel), webUrl).toString();
}
