// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the consent, device activation and connections pages share (E9-consent; ADR 0027 §1-2):
 * the slice of the API client they call (a fake in tests), the browser navigation they do, and
 * how an oRPC error maps to what the page shows.
 */
import type { Api } from "../../lib/api.ts";
import { errorCode } from "../../lib/api.ts";
import { errorRequirement } from "../../lib/coop.ts";

/** The procedures these pages call: `api().developer` in the app, a fake in tests. */
export type OAuthClient = Pick<Api["developer"], "oauth" | "grants">;

export type DeviceConsentDto = Awaited<ReturnType<Api["developer"]["oauth"]["activation"]>>;
export type AppSummaryDto = DeviceConsentDto["app"];
export type GrantDto = Awaited<ReturnType<Api["developer"]["grants"]["list"]>>[number];
export type ConsentRequestInput = Parameters<Api["developer"]["oauth"]["request"]>[0];

/**
 * Full navigations away from the page. `assign` after a decision (the API built the URL from the
 * app's registered redirect URI), `replace` when the request goes straight back (no history entry
 * for a page the user never saw).
 */
export interface Navigator {
  assign(url: string): void;
  replace(url: string): void;
}

export const browserNavigator: Navigator = {
  assign: (url) => window.location.assign(url),
  replace: (url) => window.location.replace(url),
};

/** Why the consent page cannot go back to the app (`oauth-consent-error` `data-error`). */
export type ConsentErrorCode = "invalid_client" | "invalid_redirect_uri" | "app_suspended" | "request_failed";

/**
 * `developer.oauth.request` refusals: an unknown client is `NOT_FOUND`; a suspended app or an
 * unregistered redirect URI is `PRECONDITION_FAILED` with that requirement. Anything else (the
 * network, a rate limit) is a failure the user can retry.
 */
export function consentError(err: unknown): ConsentErrorCode {
  const code = errorCode(err);
  if (code === "NOT_FOUND") return "invalid_client";
  if (code === "PRECONDITION_FAILED") {
    const requirement = errorRequirement(err);
    if (requirement === "app_suspended" || requirement === "invalid_redirect_uri") return requirement;
  }
  return "request_failed";
}

/** Why a device code was refused (`device-error` `data-error`). */
export type DeviceErrorCode = "not_found" | "expired" | "app_suspended";

/** `developer.oauth.activation` / `activate` refusals; null for a failure worth retrying. */
export function deviceError(err: unknown): DeviceErrorCode | null {
  const code = errorCode(err);
  if (code === "NOT_FOUND") return "not_found";
  if (code === "PRECONDITION_FAILED") {
    const requirement = errorRequirement(err);
    if (requirement === "expired" || requirement === "app_suspended") return requirement;
  }
  return null;
}

/** RFC 8628 user codes are eight letters; shown as `XXXX-XXXX`. */
export const USER_CODE_LENGTH = 8;

/** The code as the user should read it back: upper case, the dash after four letters. */
export function formatUserCode(normalized: string): string {
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}
