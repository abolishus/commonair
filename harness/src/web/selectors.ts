// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web app ↔ harness contract from `docs/testing/e1-selectors.md`, `e2-selectors.md` and
 * `e3-selectors.md`: routes and `data-testid` values. Scenarios select only by these
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

export const TEST_IDS = { ...E1_TEST_IDS, ...E2_TEST_IDS, ...E3_TEST_IDS } as const;

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

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];

/** Route patterns exactly as the E1 document writes them (`$channel` = the channel slug). */
export const ROUTE_PATTERNS = ["/", "/signup", "/signin", "/dashboard", "/$channel", "/embed/$channel"] as const;

/** Routes the E2 document changes (a subset of ROUTE_PATTERNS: `/` is the directory now). */
export const E2_ROUTE_PATTERNS = ["/", "/$channel"] as const;

/** Routes the E3 document adds or changes (`/relays` is new). */
export const E3_ROUTE_PATTERNS = ["/relays", "/dashboard", "/$channel"] as const;

export const ROUTES = {
  home: "/",
  /** E2: `/` is the directory. */
  directory: "/",
  signup: "/signup",
  signin: "/signin",
  dashboard: "/dashboard",
  /** E3: your relays. */
  relays: "/relays",
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
