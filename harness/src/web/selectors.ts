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
  resendVerification: "resend-verification",
  resendVerificationSent: "resend-verification-sent",
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
  appearanceSlot: "appearance-slot",
  appearanceFile: "appearance-file",
  appearancePreview: "appearance-preview",
  appearanceUpload: "appearance-upload",
  appearanceRemove: "appearance-remove",
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

/** Overhaul D6.1: transparency v2 on `/transparency` (apps/web/tests/d6-transparency.test.tsx renders each). */
export const D6_TRANSPARENCY_TEST_IDS = {
  transparencyNumbers: "transparency-numbers",
  transparencyFeePromise: "transparency-fee-promise",
  transparencyFeeCompareRow: "transparency-fee-compare-row",
  transparencySpending: "transparency-spending",
  transparencyDeficit: "transparency-deficit",
  transparencyDeficitNote: "transparency-deficit-note",
  transparencyTreasurerNote: "transparency-treasurer-note",
  transparencyCommitments: "transparency-commitments",
  transparencyMonthCard: "transparency-month-card",
  transparencyAllDecisions: "transparency-all-decisions",
  transparencyLoadError: "transparency-load-error",
  transparencyHowWeCount: "transparency-how-we-count",
  transparencyNoteEditor: "transparency-note-editor",
  transparencyNoteBody: "transparency-note-body",
  transparencyNoteSave: "transparency-note-save",
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

/** `data-source` values of `player` (never `p2p`: that is a loader, not a playlist source). */
export const PLAYER_SOURCES = ["origin", "relay", "cdn"] as const;
export type PlayerSource = (typeof PLAYER_SOURCES)[number];

/** P1 (ADR 0005 amendment 1, docs/testing/p1-selectors.md): P2P controls and indicator. */
export const P1_TEST_IDS = {
  /** Indicator on the player while P2P is on; carries the state as `data-p2p` on `player`. */
  playerP2p: "player-p2p",
  /** First-run notice that peers see the viewer's IP address (operator default `on` only). */
  playerP2pNotice: "player-p2p-notice",
  playerP2pDialog: "player-p2p-dialog",
  playerP2pToggle: "player-p2p-toggle",
  /** The P2P switch on `/settings/preferences` (Playback; moved from Privacy in D7.1). */
  privacyP2pToggle: "privacy-p2p-toggle",
} as const;

/**
 * The design batches D1–D5 (.claude/briefs/d/, docs/design/2026-11-design-review.md), registered
 * once by D0 so no two D units edit this file. The `d-surfaces` scenario uses them.
 */
export const D_TEST_IDS = {
  // D1: discovery (the directory, category pages, search, the side rail, the home page).
  directoryPage: "directory-page",
  directoryCategoryGrid: "directory-category-grid",
  categoryPage: "category-page",
  categoryTabLive: "category-tab-live",
  categoryTabVideos: "category-tab-videos",
  categoryTabClips: "category-tab-clips",
  searchPage: "search-page",
  searchResultsChannels: "search-results-channels",
  searchResultsCategories: "search-results-categories",
  headerSearch: "header-search",
  sideRail: "side-rail",
  sideRailItem: "side-rail-item",
  homeHero: "home-hero",
  homeCategoriesShelf: "home-categories-shelf",
  homeRecentTile: "home-recent-tile",
  // D2: the channel page, the player and chat.
  channelTabs: "channel-tabs",
  channelTabHome: "channel-tab-home",
  channelTabVideos: "channel-tab-videos",
  channelTabClips: "channel-tab-clips",
  channelTabAbout: "channel-tab-about",
  channelOfflineHero: "channel-offline-hero",
  channelOfflineHome: "channel-offline-home",
  channelVideoGrid: "channel-video-grid",
  channelMetaCategory: "channel-meta-category",
  channelMetaUptime: "channel-meta-uptime",
  channelShare: "channel-share",
  playerControls: "player-controls",
  playerSettings: "player-settings",
  playerFullscreen: "player-fullscreen",
  playerTheatre: "player-theatre",
  playerPip: "player-pip",
  playerShortcutsDialog: "player-shortcuts-dialog",
  playerDataSaverChip: "player-data-saver-chip",
  chatPinnedStrip: "chat-pinned-strip",
  chatOffline: "chat-offline",
  chatGated: "chat-gated",
  // D3: the VOD and clip watch pages.
  watchMeta: "watch-meta",
  watchChannelCard: "watch-channel-card",
  watchMoreGrid: "watch-more-grid",
  watchShare: "watch-share",
  // D4: polish.
  skipLink: "skip-link",
  emptyStateAction: "empty-state-action",
  accountThemeSwitcher: "account-theme-switcher",
  /** D4 (F17): the date of birth is three selects inside the `signup-birthdate` fieldset. */
  signupBirthdateDay: "signup-birthdate-day",
  signupBirthdateMonth: "signup-birthdate-month",
  signupBirthdateYear: "signup-birthdate-year",
} as const;

/**
 * Overhaul wave 3, d4-chat: the moderator's chat modes (header menu on the channel page, toolbar
 * in the mod view), the per-message Delete, timeout lengths and Report, the incoming-raid alert,
 * the viewer's mode chips and composer gate, and the points popover. `chat-mod-timeout` (E2) stays
 * the 10-minute item; the other lengths are `chatModTimeoutFor(seconds)`. Kept out of `TEST_IDS`.
 */
export const D4_CHAT_IDS = {
  chatModes: "chat-modes",
  chatModesToolbar: "chat-modes-toolbar",
  chatModeSlow: "chat-mode-slow",
  chatModeSlowOption: (seconds: number) => `chat-mode-slow-${seconds}`,
  chatModeFollowers: "chat-mode-followers",
  chatModeFollowersOption: (minutes: number | "off") => `chat-mode-followers-${minutes}`,
  chatModeSubs: "chat-mode-subs",
  chatModeEmote: "chat-mode-emote",
  chatModeClear: "chat-mode-clear",
  chatModeClearDialog: "chat-mode-clear-dialog",
  chatModeChips: "chat-mode-chips",
  chatModeChip: "chat-mode-chip",
  chatModDelete: "chat-mod-delete",
  chatModTimeoutFor: (seconds: number) => (seconds === 600 ? "chat-mod-timeout" : `chat-mod-timeout-${seconds}`),
  chatMessageReport: "chat-message-report",
  chatRaidAlert: "chat-raid-alert",
  chatRaidFollowers: "chat-raid-followers",
  chatRaidSlow: "chat-raid-slow",
  chatRaidDismiss: "chat-raid-dismiss",
  chatComposerGate: "chat-composer-gate",
  chatPointsPopover: "chat-points-popover",
  chatPointsRate: "chat-points-rate",
  chatPointsBalance: "chat-points-balance",
  chatPointsPrediction: "chat-points-prediction",
} as const;

/**
 * The follow-up ids (data-testid) on the channel page: About's social links and the Clips tab's
 * sort and range filter. Kept out of `TEST_IDS` because the range and sort ids are built per value.
 */
export const FU_CHANNEL_IDS = {
  channelSocials: "channel-socials",
  channelSocialLink: "channel-social-link",
  clipFilters: "clip-filters",
  clipRange: (range: "7d" | "30d" | "all") => `clip-range-${range}`,
  clipSort: (sort: "recent" | "top") => `clip-sort-${sort}`,
  clipsFilteredEmpty: "clips-filtered-empty",
} as const;

/**
 * Overhaul wave 3, d4-layout, on the channel page. Below `lg` the page is a sticky player over the
 * "Chat | About" switch (`watchPanelSwitch`, `data-panel`; the page root carries
 * `data-watch-panel`); Share and Report move into `channel-overflow` (`overflowShare`). Exactly
 * one `follow-button` at every width: offline on Home it is inside the Follow hero. The owner gets
 * the two shortcuts, a non-owner moderator or editor `modView`. `trustBadge` (offline header) and
 * `aboutTrust` carry `data-kind` council|member. `verifiedViewers` (from `lg`) and
 * `verifiedViewersMobile` (About panel) read "Verified viewers" (no "How we count" link yet).
 */
export const D4_LAYOUT_IDS = {
  watchPanelSwitch: "watch-panel-switch",
  watchPanelChat: "watch-panel-chat",
  watchPanelAbout: "watch-panel-about",
  watchAboutIntro: "watch-about-intro",
  overflowShare: "channel-overflow-share",
  ownerStreamManager: "channel-owner-stream-manager",
  ownerEdit: "channel-owner-edit",
  modView: "channel-mod-view",
  trustBadge: "channel-trust-badge",
  aboutTrust: "channel-about-trust",
  verifiedViewers: "channel-verified-viewers",
  verifiedViewersMobile: "channel-verified-viewers-mobile",
  offlineFollowHero: "channel-offline-follow-hero",
} as const;

/** The follow-up ids on a category page: the header's verified viewers and tags, and the media tabs. */
export const FU_CATEGORY_IDS = {
  categoryViewerCount: "category-viewer-count",
  categoryTags: "category-tags",
  categoryTag: "category-tag",
  categoryMediaEmpty: "category-media-empty",
  videoGrid: "channel-video-grid",
  videoCard: "channel-video-card",
} as const;

/**
 * The social links editor inside the studio's `stream-info` card. Each row is `socialRow` with
 * `data-index` (0-based, in saved order); the row's controls are found inside it. The platform
 * select carries its value as `data-value`, and its options are `socialPlatformOption(platform)`.
 */
export const FU_SOCIALS_EDITOR_IDS = {
  socials: "stream-info-socials",
  socialsEmpty: "stream-info-socials-empty",
  socialsFull: "stream-info-socials-full",
  socialRow: "stream-info-social",
  socialPlatform: "stream-info-social-platform",
  socialPlatformOption: (platform: string) => `stream-info-social-platform-${platform}`,
  socialUrl: "stream-info-social-url",
  socialError: "stream-info-social-error",
  socialUp: "stream-info-social-up",
  socialDown: "stream-info-social-down",
  socialRemove: "stream-info-social-remove",
  socialAdd: "stream-info-social-add",
  save: "stream-info-save",
} as const;

export const TEST_IDS = {
  ...E1_TEST_IDS,
  ...E2_TEST_IDS,
  ...E3_TEST_IDS,
  ...E4B_TEST_IDS,
  ...E4B_NESTED_TEST_IDS,
  ...E4C_TEST_IDS,
  ...E4C_NESTED_TEST_IDS,
  ...P1_TEST_IDS,
  ...D_TEST_IDS,
} as const;

/**
 * `data-p2p` values of `player`: `off` (no P2P), `on` (P2P loader running, no peer yet),
 * `sharing` (exchanging segments with at least one peer).
 */
export const P2P_STATES = ["off", "on", "sharing"] as const;
export type P2PState = (typeof P2P_STATES)[number];

/**
 * localStorage key of the viewer's P2P choice, `on` or `off`. Absent: the operator default
 * (`instance.info` `features.p2pDefault`, `off` unless the operator set `P2P_DEFAULT=on`).
 */
export const P2P_PREFERENCE_KEY = "commonair:p2p";
/** localStorage key set to `seen` once the viewer has seen the IP disclosure. */
export const P2P_NOTICE_KEY = "commonair:p2p-notice";

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
  /** D5-studio: the stream setup cards (key, avatar, DVR, simulcast, Discord, federation). */
  dashboardSettings: "/dashboard/settings",
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
  /** D1 (decision (a)): the category directory; the nav label stays "Browse". */
  browse: "/directory",
  /** D1: one category's live channels, videos and clips. */
  category: (slug: string) => `/directory/${encodeURIComponent(slug)}`,
  /** D1: channels and categories matching `q`. */
  search: (q: string) => `/search?${new URLSearchParams({ q }).toString()}`,
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

/**
 * Overhaul wave 3, d4-follow (README D4.3): the Following split button, whose menu trigger keeps
 * `follow-button` (`data-following="true"`), and the one-time first-follow alert prompt.
 */
export const D4_FOLLOW_TEST_IDS = {
  followBell: "follow-bell",
  followMenu: "follow-menu",
  followMenuAlertsAll: "follow-menu-alerts-all",
  followMenuAlertsOff: "follow-menu-alerts-off",
  followMenuMove: "follow-menu-move",
  followMenuUnfollow: "follow-menu-unfollow",
  followUnfollowDialog: "follow-unfollow-dialog",
  firstFollowPrompt: "first-follow-prompt",
  firstFollowPush: "first-follow-push",
  firstFollowEmail: "first-follow-email",
  firstFollowDismiss: "first-follow-dismiss",
} as const;

/** Absolute URL of the web app's embed route for a channel (what `--player web` opens). */
export function webEmbedUrl(webUrl: string, channel: string): string {
  return new URL(ROUTES.embed(channel), webUrl).toString();
}

/**
 * d5-dashboard (overhaul wave 3, D5.1 to D5.3): the go-live checklist and the stream recap on
 * `/dashboard`. Each checklist step is `[data-step="<StreamSetupStep>"]` inside `setupChecklist`,
 * with `data-state` done, current or todo; the list carries `data-phase` (setup or after) and
 * `data-current`. The recap carries `data-settled`, the video row `data-video`. Kept out of
 * `TEST_IDS`, like the follow-up ids.
 */
export const D5_DASHBOARD_IDS = {
  setupChecklist: "setup-checklist",
  setupChecklistError: "setup-checklist-error",
  setupChecklistRetry: "setup-checklist-retry",
  setupCreateKey: "setup-create-key",
  setupServerUrl: "setup-server-url",
  setupStreamKey: "setup-stream-key",
  setupStreamKeyReveal: "setup-stream-key-reveal",
  setupEncoderWaiting: "setup-encoder-waiting",
  setupEncoderSlow: "setup-encoder-slow",
  encoderGuide: "encoder-guide",
  encoderGuideObsProfile: "encoder-guide-obs-profile",
  setupAudience: "setup-audience",
  setupAudienceChannelCopy: "setup-audience-channel-copy",
  setupAudienceCreate: "setup-audience-create",
  setupAudienceDone: "setup-audience-done",
  streamRecap: "stream-recap",
  streamRecapStats: "stream-recap-stats",
  streamRecapVideo: "stream-recap-video",
  streamRecapDismiss: "stream-recap-dismiss",
  streamRecapMember: "stream-recap-member",
  streamPreviewToggle: "stream-preview-toggle",
} as const;

/**
 * d6-studio (overhaul wave 4, D6.4 and J2-h): the checklist's "Get paid" step (`[data-step="get_paid"]`
 * inside `setupChecklist`; its detail carries `data-state` manual, waiting, connect or unknown) and the co-op card on
 * `/dashboard` (`data-status` member, lapsed or notYet). Kept out of `TEST_IDS`.
 */
export const D6_STUDIO_IDS = {
  setupGetPaidAction: "setup-step-get_paid-action",
  setupGetPaidRevenue: "setup-step-get_paid-revenue",
  setupGetPaid: "setup-get-paid",
  setupGetPaidInstructions: "setup-get-paid-instructions",
  setupGetPaidMark: "setup-step-get_paid-mark",
  setupGetPaidSkip: "setup-step-get_paid-skip",
  studioCoopCard: "studio-coop-card",
  studioCoopCardLoading: "studio-coop-card-loading",
  studioCoopCardError: "studio-coop-card-error",
  studioCoopCardRetry: "studio-coop-card-retry",
  studioCoopStatus: "studio-coop-status",
  studioCoopCouncil: "studio-coop-council",
  studioCoopProgress: "studio-coop-progress",
  studioCoopMembership: "studio-coop-membership",
  studioCoopAbout: "studio-coop-about",
} as const;

/**
 * d5-shell (overhaul wave 3, D5.2 and D5.8, J5-a): the sticky LiveStatusBar on every studio page
 * (`data-state` offline, starting or live on `studioStatusBar`), the studio nav's new items and the
 * account menu's "Creator studio" and "Mod view". A moderated channel's nav link is
 * `${D5_SHELL_MODERATED_LINK_PREFIX}<slug>`, one per channel. Kept out of `TEST_IDS`.
 */
export const D5_SHELL_IDS = {
  studioStatusBar: "studio-status-bar",
  studioStatusManager: "studio-status-manager",
  studioStatusChannel: "studio-status-channel",
  studioStatusError: "studio-status-error",
  studioStatusRetry: "studio-status-retry",
  studioAudienceLink: "studio-audience-link",
  studioModViewLink: "studio-mod-view-link",
  accountStudioLink: "account-studio-link",
  accountModViewLink: "account-mod-view-link",
} as const;

export const D5_SHELL_MODERATED_LINK_PREFIX = "studio-moderated-link-";

/**
 * d5-content (overhaul wave 3, D5.4 and D5.5), beside the E6 ids (`e6/selectors.ts`), which keep
 * their names: on `/content` a video card (`vod-row`) opens `vodEditSheet` (`data-vod-id`) with
 * its Edit button; `vod-title`, `vod-visibility` and `vod-save` are inside the sheet now, not the
 * card. On `/overlays` one save bar (`alertSaveBar`, `data-dirty` = changed types) holds the only
 * `alert-save`; each type is a tab. The token panel shows all three links: `overlay-url` (alerts)
 * and `overlayUrlChat` / `overlayUrlGoals`, each with `data-url`, `data-width` and `data-height`.
 */
export const D5_CONTENT_IDS = {
  vodEdit: "vod-edit",
  vodEditSheet: "vod-edit-sheet",
  vodCopyLink: "vod-copy-link",
  clipCopyLink: "clip-copy-link",
  contentSort: "content-sort",
  alertSaveBar: "alert-save-bar",
  alertDiscard: "alert-discard",
  alertTab: (type: "tip" | "follow" | "subscription" | "raid") => `alert-tab-${type}`,
  overlayUrlChat: "overlay-url-chat",
  overlayUrlGoals: "overlay-url-goals",
  overlaySizes: "overlay-sizes",
  overlayObsHelp: "overlay-obs-help",
} as const;

/**
 * d5-money (overhaul wave 3, D5.6 and D5.7): `/revenue` and `/analytics`. `revenuePaidOut` carries
 * `data-cents`; each `revenueReconcileRow` carries `data-term` (gross, coopCut, refunds, other,
 * net) and signed `data-cents`, and the rows above net sum to it; `revenueReconcilePayouts`
 * carries `data-paid-out` and `data-pending`; `revenueShareLine` carries `data-share`
 * (`platform.cut`'s streamer share); `revenuePayoutAccount` (E4b) now also carries `data-state`
 * (ready, connect, manual, waiting). `revenueSetup` shows only while tiers or payouts are missing.
 * On `/analytics`, each `analyticsInsight` carries `data-insight` and `data-ready`, and
 * `analyticsPnlRow` carries `data-broadcast-id`, `data-revenue` and `data-cost` (cents).
 */
export const D5_MONEY_IDS = {
  revenuePaidOut: "revenue-paid-out",
  revenueShareLine: "revenue-share-line",
  revenueFeeHistory: "revenue-fee-history",
  revenueReconcile: "revenue-reconcile",
  revenueReconcileRow: "revenue-reconcile-row",
  revenueReconcilePayouts: "revenue-reconcile-payouts",
  revenueSetup: "revenue-setup",
  revenueTrend: "revenue-trend",
  analyticsRangeEarned: "analytics-range-earned",
  analyticsCounted: "analytics-counted",
  analyticsInsights: "analytics-insights",
  analyticsInsight: "analytics-insight",
  analyticsInsightOpen: "analytics-insight-open",
  analyticsPnl: "analytics-pnl",
  analyticsPnlRow: "analytics-pnl-row",
} as const;

/**
 * d6-governance (overhaul wave 4, D6.2 and D6.3), beside the E5 ids (`coop-selectors.ts`), which
 * keep their names. On `/coop/proposals/new` a known setting's row gets typed fields
 * (`proposalChangeFields`, `data-typed="true"` on `proposal-change`) and its JSON
 * (`proposal-change-value`) moves under `proposalChangeAdvanced` (kept mounted, hidden until
 * opened); `proposal-save` stays enabled and carries `data-valid`. `/coop/settings` groups rows by
 * theme (`settingsGroup`, `data-theme`); `setting-row` keeps `data-key`, `data-protected` and
 * `data-updated-by`. Result bars carry `data-rule` and `data-passed`; a signed-out voter gets
 * `voteJoin` instead of the ballot. `/coop/council` keeps every `council-member` tile mounted (past
 * the top 12 they are `hidden` until `councilShowAll`), so reading their data needs no click.
 */
export const D6_GOVERNANCE_IDS = {
  proposalChangeAdvanced: "proposal-change-advanced",
  proposalChangeFields: "proposal-change-fields",
  proposalChangePreview: "proposal-change-preview",
  proposalFormProblems: "proposal-form-problems",
  proposalNextStep: "proposal-next-step",
  proposalParticipation: "proposal-participation",
  voteJoin: "vote-join",
  voteJoinCreate: "vote-join-create",
  voteJoinSignIn: "vote-join-signin",
  voteJoinMembership: "vote-join-membership",
  voteResultBars: "vote-result-bars",
  voteResultBar: "vote-result-bar",
  voteResultRule: "vote-result-rule",
  councilShowAll: "council-show-all",
  councilElections: "council-elections",
  coopCouncilAll: "coop-council-all",
  electionDeadline: "election-deadline",
  electionJoin: "election-join",
  settingsGroups: "settings-groups",
  settingsGroup: "settings-group",
  settingValue: "setting-value",
  settingChangedBy: "setting-changed-by",
} as const;

/**
 * d7-settings (overhaul wave 4, D7.1, D7.2, D7.4): the settings shell, `/settings/account` and
 * Privacy & data. `settingsNav` carries `data-current` (the nav item id); each nav link is
 * `settings-tab-<item>` (from `lg`) and the select below `lg` is `settingsNavSelect`.
 * `deletionBanner` shows on every settings page while a deletion is scheduled and carries
 * `data-scheduled-for`; `privacyDelete` is the page's danger zone (`#delete-account`), holding
 * `deletion-request` or `deletion-status`; each `deletionImpactLine` in the dialog carries
 * `data-kind` (removed, kept, subscriptions, channelSubscriptions, payout, membership, legalHold).
 */
export const D7_SETTINGS_IDS = {
  settingsNav: "settings-nav",
  settingsNavSelect: "settings-nav-select",
  settingsMain: "settings-main",
  settingsTabAccount: "settings-tab-account",
  settingsTabPrivacy: "settings-tab-privacy",
  deletionBanner: "deletion-banner",
  deletionBannerCancel: "deletion-banner-cancel",
  accountPage: "account-page",
  accountDisplayName: "account-display-name",
  accountDisplayNameSave: "account-display-name-save",
  accountUsername: "account-username",
  accountEmailStatus: "account-email-status",
  accountShareEmail: "account-share-email",
  accountMature: "account-mature",
  privacyDownload: "privacy-download",
  privacyDelete: "privacy-delete",
  deletionDialog: "deletion-dialog",
  deletionImpactLine: "deletion-impact-line",
  deletionDownloaded: "deletion-downloaded",
  preferencesTheme: "preferences-theme",
  preferencesPlayback: "preferences-playback",
} as const;

/**
 * d7-security (overhaul wave 4, D7.2): `/settings/security` and the sign-in's code step. The
 * two-step row carries `data-state` (on, off); the set-up dialog carries `data-step` (password,
 * scan, code, codes); the code step carries `data-mode` (totp, backup); each session row carries
 * `data-current` (true, false). Kept out of `TEST_IDS`: select with `d7Locator`
 * (`harness/src/d7/security.ts`).
 */
export const D7_SECURITY_IDS = {
  securityPage: "security-page",
  securityRow: "security-2fa-row",
  securitySetup: "security-2fa-setup",
  securityDialog: "security-2fa-dialog",
  securityPassword: "security-2fa-password",
  securityContinue: "security-2fa-continue",
  securityQr: "security-2fa-qr",
  securityKey: "security-2fa-key",
  securityKeyReveal: "security-2fa-key-reveal",
  securityNext: "security-2fa-next",
  securityCode: "security-2fa-code",
  securityVerify: "security-2fa-verify",
  securityBackupCodes: "security-backup-codes",
  securitySaved: "security-2fa-saved",
  securityOff: "security-2fa-off",
  securityConfirmPassword: "security-confirm-password",
  securitySessions: "security-sessions",
  securitySessionRow: "security-session-row",
  signinCodeStep: "signin-2fa-step",
  signinCode: "signin-2fa-code",
  signinCodeSubmit: "signin-2fa-submit",
  signinCodeMode: "signin-2fa-mode",
  signinPasskey: "signin-passkey",
} as const;

export const D7_SECURITY_ROUTES = { security: "/settings/security" } as const;

/**
 * d7-notify (overhaul wave 4, D7.3): the notifications grid on `/settings/notifications` and the
 * `/inbox` page. Each `notifyGridRow` carries `data-type` (a preference type); each
 * `notifyAlwaysRow` carries `data-row`; switches carry `data-state` (on, off) and `data-builtin`.
 * The go-live cells keep their N1 ids (`notify-default-*`). Each `inboxGroup` carries
 * `data-group` (today, week, earlier).
 */
export const D7_NOTIFY_IDS = {
  notifyGrid: "notify-grid",
  notifyGridRow: "notify-grid-row",
  notifyAlwaysRow: "notify-always-row",
  notifyCellNone: "notify-cell-none",
  notifyCellAlways: "notify-cell-always",
  notifyGovernanceInApp: "notify-pref-governance-in_app",
  notifyPayoutEmail: "notify-pref-payout-email",
  notifyCreatorInApp: "notify-pref-creator-in_app",
  notifyCreatorEmail: "notify-pref-creator-email",
  notifyDigestEmail: "notify-pref-digest_weekly-email",
  notifyTypesLoadError: "notify-types-load-error",
  notifySaved: "notify-saved",
  notifyFollowingLink: "notify-following-link",
  notificationSeeAll: "notification-see-all",
  notificationItemIcon: "notification-item-icon",
  notificationItemContext: "notification-item-context",
  inboxPage: "inbox-page",
  inboxFilters: "inbox-filters",
  inboxFilterAll: "inbox-filter-all",
  inboxFilterLive: "inbox-filter-live",
  inboxFilterCoop: "inbox-filter-coop",
  inboxFilterAccount: "inbox-filter-account",
  inboxGroup: "inbox-group",
  inboxMarkAllRead: "inbox-mark-all-read",
  inboxLoadMore: "inbox-load-more",
  inboxEmpty: "inbox-empty",
  inboxEmptyDirectory: "inbox-empty-directory",
  inboxEmptyFiltered: "inbox-empty-filtered",
  inboxShowAll: "inbox-show-all",
  inboxSettingsLink: "inbox-settings-link",
  inboxLoadError: "inbox-load-error",
} as const;
