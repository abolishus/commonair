// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The N1 web ↔ harness contract (docs/testing/n1-selectors.md): routes and the `data-testid`s the
 * `notifications` steps select by. A unit test checks every id here against the document. Owned by
 * the orchestrator: units send a contract request instead of editing it.
 */
import type { Locator, Page } from "playwright";

export const N1_TEST_IDS = {
  // Header (signed in)
  bell: "notification-bell",
  bellBadge: "notification-bell-badge",
  list: "notification-list",
  item: "notification-item",
  itemLink: "notification-item-link",
  markAllRead: "notification-mark-all-read",
  loadMore: "notification-load-more",
  empty: "notification-empty",
  settingsLink: "notification-settings-link",
  accountLink: "account-notifications-link",
  signOut: "nav-signout",
  // Settings
  defaultInApp: "notify-default-in_app",
  defaultEmail: "notify-default-email",
  defaultPush: "notify-default-push",
  emailUnverified: "notify-email-unverified",
  channel: "notify-channel",
  channelBell: "notify-channel-bell",
  channelEmail: "notify-channel-email",
  channelEmailDefault: "notify-channel-email-default",
  channelEmailOn: "notify-channel-email-on",
  channelEmailOff: "notify-channel-email-off",
  channelPush: "notify-channel-push",
  channelPushDefault: "notify-channel-push-default",
  channelPushOn: "notify-channel-push-on",
  channelPushOff: "notify-channel-push-off",
  saveError: "notify-save-error",
  // Push toggle
  pushToggle: "push-toggle",
  pushUnsupported: "push-unsupported",
  pushDeniedHelp: "push-denied-help",
  // Unsubscribe page
  unsubscribePage: "unsubscribe-page",
  unsubscribeConfirm: "unsubscribe-confirm",
  unsubscribeDone: "unsubscribe-done",
  unsubscribeInvalid: "unsubscribe-invalid",
  // PWA
  pwaUpdatePrompt: "pwa-update-prompt",
  pwaUpdateReload: "pwa-update-reload",
  // Discord
  discordSection: "discord-webhook-section",
  discordStatus: "discord-webhook-status",
  discordInput: "discord-webhook-input",
  discordSave: "discord-webhook-save",
  discordTest: "discord-webhook-test",
  discordRemove: "discord-webhook-remove",
  discordRemoveConfirm: "discord-webhook-remove-confirm",
} as const;

export type N1TestId = (typeof N1_TEST_IDS)[keyof typeof N1_TEST_IDS];

/** `push-toggle`'s `data-state` values (spec "Push toggle"). */
export const PUSH_TOGGLE_STATES = ["unsupported", "unavailable", "denied", "off", "on", "busy"] as const;
export type PushToggleState = (typeof PUSH_TOGGLE_STATES)[number];

/** An option item: `<field>-<value>` (spec "Rules"), e.g. `notify-channel-email-off`. */
export function n1Option(fieldId: string, value: string): string {
  return `${fieldId}-${value}`;
}

export const N1_ROUTES = {
  settings: "/settings/notifications",
  unsubscribe: "/settings/notifications/unsubscribe",
  dashboard: "/dashboard",
  manifest: "/manifest.webmanifest",
  serviceWorker: "/sw.js",
  icons: "/icons/*",
  /** The API's one-click route (spec "Rules"): `POST` applies, `GET` redirects to `unsubscribe`. */
  apiUnsubscribe: "/api/email/unsubscribe",
} as const;

/** Every route the N1 document's "Routes" table lists (first-column code spans, in order). */
export const N1_ROUTE_PATTERNS = [
  "/settings/notifications",
  "/settings/notifications/unsubscribe",
  "/dashboard",
  "/manifest.webmanifest",
  "/sw.js",
  "/icons/*",
] as const;

function cssEscape(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** CSS selector for a test id with optional `data-*` constraints. */
export function n1tid(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${cssEscape(v)}"]`)
    .join("");
  return `[data-testid="${cssEscape(id)}"]${attrs}`;
}

export function byN1Id(scope: Page | Locator, id: string, data?: Record<string, string>): Locator {
  return scope.locator(n1tid(id, data));
}
