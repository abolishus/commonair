// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The E6 web ↔ harness contract (docs/testing/e6-selectors.md): routes and the `data-testid`s the
 * E6 scenarios select by. Kept beside the scenarios (the shared `web/selectors.ts` lists E1–E4c);
 * a unit test checks every id here against the document.
 */
import type { Locator, Page } from "playwright";

export const E6_TEST_IDS = {
  // /dashboard simulcast
  simulcast: "simulcast",
  simulcastEmpty: "simulcast-empty",
  simulcastTarget: "simulcast-target",
  simulcastName: "simulcast-name",
  simulcastPlatform: "simulcast-platform",
  simulcastUrl: "simulcast-url",
  simulcastKey: "simulcast-key",
  simulcastAdd: "simulcast-add",
  simulcastEnabled: "simulcast-enabled",
  simulcastRemove: "simulcast-remove",
  simulcastError: "simulcast-error",
  simulcastLimit: "simulcast-limit",
  // /overlays
  alertConfig: "alert-config",
  alertEnabled: "alert-enabled",
  alertMessage: "alert-message",
  alertMinAmount: "alert-min-amount",
  alertDuration: "alert-duration",
  alertAnimation: "alert-animation",
  alertSave: "alert-save",
  alertTest: "alert-test",
  overlayToken: "overlay-token",
  overlayExpiry: "overlay-expiry",
  overlayExpiryDate: "overlay-expiry-date",
  overlayTokenCreate: "overlay-token-create",
  overlayUrl: "overlay-url",
  overlayUrlValue: "overlay-url-value",
  overlayTokenRevoke: "overlay-token-revoke",
  // /overlay/alerts
  overlayAlerts: "overlay-alerts",
  overlayAlert: "overlay-alert",
  overlayAlertText: "overlay-alert-text",
  overlayAlertMessage: "overlay-alert-message",
  // /content
  contentVods: "content-vods",
  contentClips: "content-clips",
  contentTabVods: "content-tab-vods",
  contentTabClips: "content-tab-clips",
  contentEmpty: "content-empty",
  vodRow: "vod-row",
  vodTitle: "vod-title",
  vodVisibility: "vod-visibility",
  vodSave: "vod-save",
  vodDelete: "vod-delete",
  clipRow: "clip-row",
  clipDelete: "clip-delete",
  // /settings/privacy
  exportRequest: "export-request",
  exportRow: "export-row",
  exportDownload: "export-download",
  exportEmpty: "export-empty",
  deletionRequest: "deletion-request",
  deletionConfirmUsername: "deletion-confirm-username",
  deletionStatus: "deletion-status",
  deletionCancel: "deletion-cancel",
} as const;

export type E6TestId = (typeof E6_TEST_IDS)[keyof typeof E6_TEST_IDS];

/** Shared with E1 (`<ConfirmDialog>`). */
export const CONFIRM_DIALOG_CONFIRM = "confirm-dialog-confirm";

/** `overlay-expiry` choices (spec "/overlays"). */
export const OVERLAY_EXPIRY_CHOICES = ["none", "1d", "7d", "30d", "90d", "6mo", "date"] as const;
export type OverlayExpiryChoice = (typeof OVERLAY_EXPIRY_CHOICES)[number];

/** A select's option: `<field test id>-option-<value>` (spec "Selector conventions"). */
export function optionId(fieldId: string, value: string): string {
  return `${fieldId}-option-${value}`;
}

export const E6_ROUTES = {
  dashboard: "/dashboard",
  overlays: "/overlays",
  content: "/content",
  privacy: "/settings/privacy",
  overlayAlerts: "/overlay/alerts",
  overlayGoals: "/overlay/goals",
  overlayChat: "/overlay/chat",
} as const;

/** Every route the E6 document's "Routes" table lists (first-column code spans, in order). */
export const E6_ROUTE_PATTERNS = [
  "/dashboard",
  "/overlays",
  "/content",
  "/settings/privacy",
  "/overlay/alerts",
  "/overlay/goals",
  "/overlay/chat",
] as const;

function cssEscape(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** CSS selector for a test id with optional `data-*` constraints. */
export function etid(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${cssEscape(v)}"]`)
    .join("");
  return `[data-testid="${cssEscape(id)}"]${attrs}`;
}

export function byE6Id(scope: Page | Locator, id: string, data?: Record<string, string>): Locator {
  return scope.locator(etid(id, data));
}
