// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * better-auth's HTTP surface as services/api mounts it. These routes are outside the oRPC
 * contract, so web, harness and SDK clients share these constants instead of copying paths.
 */
export const AUTH_BASE_PATH = "/api/auth";

export const AUTH_ROUTES = {
  /** GET: a fresh ALTCHA proof-of-work challenge (self-hosted). */
  altchaChallenge: `${AUTH_BASE_PATH}/altcha-challenge`,
  signUp: `${AUTH_BASE_PATH}/sign-up/email`,
  signIn: `${AUTH_BASE_PATH}/sign-in/email`,
  signOut: `${AUTH_BASE_PATH}/sign-out`,
  /** Target of the verification link in the sign-up email. */
  verifyEmail: `${AUTH_BASE_PATH}/verify-email`,
} as const;

/** Body field of `AUTH_ROUTES.signUp` carrying the solved ALTCHA payload (base64 JSON). */
export const ALTCHA_FIELD = "altcha";
