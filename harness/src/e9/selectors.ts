// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The E9 web ↔ harness contract (docs/testing/e9-selectors.md): routes and the `data-testid`s the
 * `developer-platform` scenario's web steps select by. A unit test checks every id here against
 * the document. Owned by the orchestrator: units send a contract request instead of editing it.
 */
import type { Locator, Page } from "playwright";

export const E9_TEST_IDS = {
  // /oauth2/authorize
  oauthConsent: "oauth-consent",
  oauthConsentOwner: "oauth-consent-owner",
  oauthConsentScope: "oauth-consent-scope",
  oauthConsentApprove: "oauth-consent-approve",
  oauthConsentDeny: "oauth-consent-deny",
  oauthConsentError: "oauth-consent-error",
  // /activate
  deviceForm: "device-form",
  deviceCode: "device-code",
  deviceSubmit: "device-submit",
  deviceConsent: "device-consent",
  deviceApprove: "device-approve",
  deviceDeny: "device-deny",
  deviceDone: "device-done",
  deviceError: "device-error",
  // /settings/connections
  accountConnectionsLink: "account-connections-link",
  connections: "connections",
  connectionsEmpty: "connections-empty",
  connection: "connection",
  connectionRevoke: "connection-revoke",
  // /developer, /developer/apps/$appId
  studioDeveloperLink: "studio-developer-link",
  devapps: "devapps",
  devappsEmpty: "devapps-empty",
  devappNew: "devapp-new",
  devappForm: "devapp-form",
  devappName: "devapp-name",
  devappDescription: "devapp-description",
  devappRedirects: "devapp-redirects",
  devappConfidential: "devapp-confidential",
  devappSubmit: "devapp-submit",
  devappFormError: "devapp-form-error",
  devappRow: "devapp-row",
  devappSecret: "devapp-secret",
  devappSecretValue: "devapp-secret-value",
  devappSecretCopy: "devapp-secret-copy",
  devappSecretDone: "devapp-secret-done",
  devapp: "devapp",
  devappClientId: "devapp-client-id",
  devappEdit: "devapp-edit",
  devappRotate: "devapp-rotate",
  devappDelete: "devapp-delete",
  devsubs: "devsubs",
  devsubsEmpty: "devsubs-empty",
  devsubNew: "devsub-new",
  devsubForm: "devsub-form",
  devsubType: "devsub-type",
  devsubCallback: "devsub-callback",
  devsubSecret: "devsub-secret",
  devsubSubmit: "devsub-submit",
  devsub: "devsub",
  devsubTest: "devsub-test",
  devsubDeliveries: "devsub-deliveries",
  devsubDelete: "devsub-delete",
  devdelivery: "devdelivery",
  devdeliveryRedeliver: "devdelivery-redeliver",
  // /developer/bots
  devbots: "devbots",
  devbotsEmpty: "devbots-empty",
  devbotNew: "devbot-new",
  devbotForm: "devbot-form",
  devbotUsername: "devbot-username",
  devbotDisplayName: "devbot-display-name",
  devbotSubmit: "devbot-submit",
  devbot: "devbot",
  devbotTokenNew: "devbot-token-new",
  devbotTokenForm: "devbot-token-form",
  devbotTokenDays: "devbot-token-days",
  devbotTokenSubmit: "devbot-token-submit",
  devbotTokenValue: "devbot-token-value",
  devbotTokenDone: "devbot-token-done",
  devtoken: "devtoken",
  devtokenRevoke: "devtoken-revoke",
  // /admin/apps
  adminAppsLink: "admin-apps-link",
  adminapps: "adminapps",
  adminappsSearch: "adminapps-search",
  adminappsFilterSuspended: "adminapps-filter-suspended",
  adminappsEmpty: "adminapps-empty",
  adminapp: "adminapp",
  adminappSuspend: "adminapp-suspend",
  adminappUnsuspend: "adminapp-unsuspend",
  adminappSuspendForm: "adminapp-suspend-form",
  adminappReason: "adminapp-reason",
  adminappSuspendSubmit: "adminapp-suspend-submit",
} as const;

export type E9TestId = (typeof E9_TEST_IDS)[keyof typeof E9_TEST_IDS];

/** An option item: `<field>-<value>` (spec "Rules"), e.g. `adminapp-reason-spam`. */
export function e9Option(fieldId: string, value: string): string {
  return `${fieldId}-${value}`;
}

/** Per-item ids the spec writes as patterns; each template is a code span in the document. */
export const E9_ID_PATTERNS = {
  devsubType: { template: "devsub-type-<type>", id: (type: string) => e9Option("devsub-type", type) },
  devsubCondition: {
    template: "devsub-condition-<field>",
    id: (field: string) => e9Option("devsub-condition", field),
  },
  devbotScope: { template: "devbot-scope-<scope>", id: (scope: string) => e9Option("devbot-scope", scope) },
  adminappReason: {
    template: "adminapp-reason-<reason>",
    id: (reason: string) => e9Option("adminapp-reason", reason),
  },
} as const;

export const E9_ROUTES = {
  authorize: "/oauth2/authorize",
  activate: "/activate",
  connections: "/settings/connections",
  developer: "/developer",
  developerApp: (appId: string) => `/developer/apps/${appId}`,
  developerBots: "/developer/bots",
  adminApps: "/admin/apps",
} as const;

/** Every route the E9 document's "Routes" table lists (first-column code spans, in order). */
export const E9_ROUTE_PATTERNS = [
  "/oauth2/authorize",
  "/activate",
  "/settings/connections",
  "/developer",
  "/developer/apps/$appId",
  "/developer/bots",
  "/admin/apps",
] as const;

function cssEscape(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** CSS selector for a test id with optional `data-*` constraints. */
export function e9tid(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${cssEscape(v)}"]`)
    .join("");
  return `[data-testid="${cssEscape(id)}"]${attrs}`;
}

export function byE9Id(scope: Page | Locator, id: string, data?: Record<string, string>): Locator {
  return scope.locator(e9tid(id, data));
}
