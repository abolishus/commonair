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
  /** POST: send a new verification link; answers the same whether or not the address exists. */
  sendVerificationEmail: `${AUTH_BASE_PATH}/send-verification-email`,
  /** Target of the verification link in the sign-up email. */
  verifyEmail: `${AUTH_BASE_PATH}/verify-email`,
  /** POST `{ email, redirectTo }`: answers the same whether or not the address has an account. */
  requestPasswordReset: `${AUTH_BASE_PATH}/request-password-reset`,
  /** POST `{ token, newPassword }`. */
  resetPassword: `${AUTH_BASE_PATH}/reset-password`,
  /** POST `{ email, callbackURL }`: magic-link sign-in for existing members. */
  magicLink: `${AUTH_BASE_PATH}/sign-in/magic-link`,

  // Overhaul wave 4 (D7.2, /settings/security): better-auth's own endpoints, already mounted.
  /** POST `{ currentPassword, newPassword, revokeOtherSessions }`. */
  changePassword: `${AUTH_BASE_PATH}/change-password`,
  /** POST `{ newEmail, callbackURL }`: mails a confirmation link to the current address first. */
  changeEmail: `${AUTH_BASE_PATH}/change-email`,
  /** GET: the caller's sessions (better-auth `Session[]`). */
  listSessions: `${AUTH_BASE_PATH}/list-sessions`,
  /** POST `{ token }`: sign one session out. */
  revokeSession: `${AUTH_BASE_PATH}/revoke-session`,
  /** POST: sign every other session out. */
  revokeOtherSessions: `${AUTH_BASE_PATH}/revoke-other-sessions`,
  /** POST `{ password }`: answers `{ totpURI, backupCodes }`; two-factor turns on only after `twoFactorVerifyTotp`. */
  twoFactorEnable: `${AUTH_BASE_PATH}/two-factor/enable`,
  /** POST `{ password }`. */
  twoFactorDisable: `${AUTH_BASE_PATH}/two-factor/disable`,
  /** POST `{ password }`: the TOTP URI again (for the QR code). */
  twoFactorGetTotpUri: `${AUTH_BASE_PATH}/two-factor/get-totp-uri`,
  /** POST `{ code, trustDevice? }`: confirms set-up, and is the second step of a two-factor sign-in. */
  twoFactorVerifyTotp: `${AUTH_BASE_PATH}/two-factor/verify-totp`,
  /** POST `{ code }`: a backup code as the second step of a sign-in. */
  twoFactorVerifyBackupCode: `${AUTH_BASE_PATH}/two-factor/verify-backup-code`,
  /** POST `{ password }`: replaces every backup code. */
  twoFactorGenerateBackupCodes: `${AUTH_BASE_PATH}/two-factor/generate-backup-codes`,
  /** GET: WebAuthn registration options. */
  passkeyRegisterOptions: `${AUTH_BASE_PATH}/passkey/generate-register-options`,
  /** POST `{ response, name? }`. */
  passkeyVerifyRegistration: `${AUTH_BASE_PATH}/passkey/verify-registration`,
  /** GET: WebAuthn authentication options (passkey sign-in). */
  passkeyAuthenticateOptions: `${AUTH_BASE_PATH}/passkey/generate-authenticate-options`,
  /** POST `{ response }`: passkey sign-in. */
  passkeyVerifyAuthentication: `${AUTH_BASE_PATH}/passkey/verify-authentication`,
  /** GET: the caller's passkeys. */
  passkeyList: `${AUTH_BASE_PATH}/passkey/list-user-passkeys`,
  /** POST `{ id }`. */
  passkeyDelete: `${AUTH_BASE_PATH}/passkey/delete-passkey`,
  /** POST `{ id, name }`. */
  passkeyRename: `${AUTH_BASE_PATH}/passkey/update-passkey`,
  /** GET: the caller's own session (`{ session, user }`), to mark "This device". */
  getSession: `${AUTH_BASE_PATH}/get-session`,
  /** POST `{ image?, name? }`: the profile update (`/settings/account`'s picture). */
  updateUser: `${AUTH_BASE_PATH}/update-user`,
} as const;

/** Where a two-factor sign-in, the new-sign-in email and the 2FA emails send the member (D7.2). */
export const SECURITY_SETTINGS_PATH = "/settings/security";
export const SESSIONS_SETTINGS_PATH = "/settings/security#sessions";

/** Body field of `AUTH_ROUTES.signUp` carrying the solved ALTCHA payload (base64 JSON). */
export const ALTCHA_FIELD = "altcha";
