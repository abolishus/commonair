// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web app ↔ harness contract from `docs/testing/e1-selectors.md` and
 * `docs/testing/e2-selectors.md`: routes and `data-testid` values. Scenarios select only by these
 * ids (never by visible text, which is translated). A unit test parses the markdown tables and
 * fails when this module and either document disagree.
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

export const TEST_IDS = { ...E1_TEST_IDS, ...E2_TEST_IDS } as const;

/** `data-section` values of `directory-section`. */
export const DIRECTORY_SECTIONS = ["spotlight", "new", "live", "following"] as const;
export type DirectorySection = (typeof DIRECTORY_SECTIONS)[number];

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];

/** Route patterns exactly as the E1 document writes them (`$channel` = the channel slug). */
export const ROUTE_PATTERNS = ["/", "/signup", "/signin", "/dashboard", "/$channel", "/embed/$channel"] as const;

/** Routes the E2 document changes (a subset of ROUTE_PATTERNS: `/` is the directory now). */
export const E2_ROUTE_PATTERNS = ["/", "/$channel"] as const;

export const ROUTES = {
  home: "/",
  /** E2: `/` is the directory. */
  directory: "/",
  signup: "/signup",
  signin: "/signin",
  dashboard: "/dashboard",
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
