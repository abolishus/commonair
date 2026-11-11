// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * /settings/security's calls on better-auth's own endpoints (D7.2, `AUTH_ROUTES`), all
 * same-origin with the session cookie.
 */
import { AUTH_BASE_PATH, SECURITY_SETTINGS_PATH } from "@commonair/contracts/auth";
import { AUTH_ROUTES, authRequest } from "../../lib/auth.ts";
import type { AuthSessionRow } from "./session-summary.ts";

/**
 * better-auth's own "who is this session" (`{ session, user }`), to mark "This device". Not in
 * `AUTH_ROUTES` yet (contract request d7-security: `getSession`).
 */
export const GET_SESSION_PATH = `${AUTH_BASE_PATH}/get-session`;

export async function currentSessionId(): Promise<string | null> {
  const data = await authRequest<{ session?: { id?: unknown } } | null>("GET", GET_SESSION_PATH);
  return typeof data?.session?.id === "string" ? data.session.id : null;
}

export async function listSessions(): Promise<AuthSessionRow[]> {
  return (await authRequest<AuthSessionRow[]>("GET", AUTH_ROUTES.listSessions)) ?? [];
}

export async function revokeSession(token: string): Promise<void> {
  await authRequest("POST", AUTH_ROUTES.revokeSession, { token });
}

export async function revokeOtherSessions(): Promise<void> {
  await authRequest("POST", AUTH_ROUTES.revokeOtherSessions, {});
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions: boolean;
}): Promise<void> {
  await authRequest("POST", AUTH_ROUTES.changePassword, input);
}

/** The confirmation goes to the current address; both links land back on this page. */
export async function changeEmail(newEmail: string): Promise<void> {
  await authRequest("POST", AUTH_ROUTES.changeEmail, { newEmail, callbackURL: SECURITY_SETTINGS_PATH });
}

export interface TotpEnrollment {
  totpURI: string;
  backupCodes: string[];
}

/** Starts set-up: the secret and backup codes exist, but two-step sign-in is on only after `verifyTotp`. */
export async function enableTwoFactor(password: string): Promise<TotpEnrollment> {
  const data = await authRequest<TotpEnrollment>("POST", AUTH_ROUTES.twoFactorEnable, { password });
  return { totpURI: data?.totpURI ?? "", backupCodes: data?.backupCodes ?? [] };
}

export async function disableTwoFactor(password: string): Promise<void> {
  await authRequest("POST", AUTH_ROUTES.twoFactorDisable, { password });
}

export async function generateBackupCodes(password: string): Promise<string[]> {
  const data = await authRequest<{ backupCodes?: string[] }>("POST", AUTH_ROUTES.twoFactorGenerateBackupCodes, {
    password,
  });
  return data?.backupCodes ?? [];
}

/** A passkey as `list-user-passkeys` answers (the fields the page reads). */
export interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt: string;
}

export async function listPasskeys(): Promise<PasskeyRow[]> {
  return (await authRequest<PasskeyRow[]>("GET", AUTH_ROUTES.passkeyList)) ?? [];
}

export async function deletePasskey(id: string): Promise<void> {
  await authRequest("POST", AUTH_ROUTES.passkeyDelete, { id });
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  await authRequest("POST", AUTH_ROUTES.passkeyRename, { id, name });
}
