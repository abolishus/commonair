// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The password reset flow on better-auth's own endpoints (services/api sends the `passwordReset`
 * email): ask for a link, and set a new password with the token the link carries. The link goes
 * through the API, which redirects to `/signin?token=` (or `?error=INVALID_TOKEN`).
 */
import { AUTH_ROUTES, authRequest } from "./auth.ts";

/** Where the reset link lands: the sign-in page, which then shows the new-password form. */
export const RESET_LANDING = "/signin";

export async function requestPasswordReset(email: string): Promise<void> {
  await authRequest("POST", AUTH_ROUTES.requestPasswordReset, { email, redirectTo: RESET_LANDING });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await authRequest("POST", AUTH_ROUTES.resetPassword, { token, newPassword });
}
