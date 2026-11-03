// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The password reset flow on better-auth's own endpoints (services/api sends the `passwordReset`
 * email): ask for a link, and set a new password with the token the link carries. The link goes
 * through the API, which redirects to `/signin?token=` (or `?error=INVALID_TOKEN`).
 *
 * The two paths belong in `AUTH_ROUTES` (`@commonair/contracts/auth`); they are here until that
 * contract change lands (D4 contract request).
 */
import { AUTH_BASE_PATH } from "@commonair/contracts/auth";
import { AuthRequestError } from "./auth.ts";

export const PASSWORD_RESET_ROUTES = {
  /** POST `{ email, redirectTo }`: answers the same whether or not the address has an account. */
  request: `${AUTH_BASE_PATH}/request-password-reset`,
  /** POST `{ token, newPassword }`. */
  reset: `${AUTH_BASE_PATH}/reset-password`,
} as const;

/** Where the reset link lands: the sign-in page, which then shows the new-password form. */
export const RESET_LANDING = "/signin";

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  const data = (await res.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  throw new AuthRequestError(
    res.status,
    typeof data?.code === "string" ? data.code : null,
    typeof data?.message === "string" ? data.message : `HTTP ${res.status}`,
  );
}

export function requestPasswordReset(email: string): Promise<void> {
  return post(PASSWORD_RESET_ROUTES.request, { email, redirectTo: RESET_LANDING });
}

export function resetPassword(token: string, newPassword: string): Promise<void> {
  return post(PASSWORD_RESET_ROUTES.reset, { token, newPassword });
}
