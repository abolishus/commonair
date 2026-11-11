// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AUTH_ROUTES } from "@commonair/contracts/auth";
import type { SignupIntent } from "@commonair/contracts/enums";

/** better-auth's HTTP surface as services/api mounts it (outside the oRPC contract). */
export { AUTH_ROUTES };

export interface SignUpInput {
  email: string;
  username: string;
  password: string;
  birthDate: string;
  altcha: string;
  acceptedDocumentIds: string[];
  /** `?intent=` (README D2.8), stored as `users.signup_intent`; the API keeps only known values. */
  signupIntent?: SignupIntent | undefined;
}

export class AuthRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

/**
 * One better-auth call: the parsed JSON body (null when there is none), or an `AuthRequestError`
 * with better-auth's error code. A GET sends no body.
 */
export async function authRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) } : {}),
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return data as T | null;
  const err = (data ?? {}) as { code?: unknown; message?: unknown };
  throw new AuthRequestError(
    res.status,
    typeof err.code === "string" ? err.code : null,
    typeof err.message === "string" ? err.message : `HTTP ${res.status}`,
  );
}

async function post(path: string, body: unknown): Promise<void> {
  await authRequest("POST", path, body);
}

/**
 * Where a verification link lands without a target (F11): home. A new account has never streamed,
 * so the studio is only ever the landing when the visitor asked for it (`?redirect=/dashboard…`).
 */
export const DEFAULT_LANDING = "/";

/**
 * `callbackURL` is where the verification link lands: home, or the page that sent the visitor to
 * sign up (`returnTo`/`redirect`, already checked by `safeRedirect`; better-auth also checks it
 * against its trusted origins).
 */
export function signUp(input: SignUpInput, callbackURL = DEFAULT_LANDING): Promise<void> {
  // The display name starts as the username. A sign-up with no intent records "none" (null is
  // left for accounts made where nobody asked, such as before the column existed).
  return post(AUTH_ROUTES.signUp, {
    ...input,
    signupIntent: input.signupIntent ?? "none",
    name: input.username,
    callbackURL,
  });
}

/**
 * Ask for a new verification link. better-auth answers `{ status: true }` (after a constant
 * delay) whether or not the address exists or is already verified, so callers show one neutral
 * confirmation and only treat a rate limit differently.
 */
export function resendVerificationEmail(email: string, callbackURL = DEFAULT_LANDING): Promise<void> {
  return post(AUTH_ROUTES.sendVerificationEmail, { email, callbackURL });
}

/** What the password step says: signed in, or a second step (two-step sign-in) comes next. */
export interface SignInResult {
  twoFactorRedirect: boolean;
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const data = await authRequest<{ twoFactorRedirect?: unknown }>("POST", AUTH_ROUTES.signIn, { email, password });
  return { twoFactorRedirect: data?.twoFactorRedirect === true };
}

/** The second step of a two-step sign-in (or the last step of setting it up): a 6-digit code. */
export function verifyTotp(code: string): Promise<void> {
  return post(AUTH_ROUTES.twoFactorVerifyTotp, { code });
}

/** The second step of a two-step sign-in with one of the backup codes (each works once). */
export function verifyBackupCode(code: string): Promise<void> {
  return post(AUTH_ROUTES.twoFactorVerifyBackupCode, { code });
}

export function signOut(): Promise<void> {
  return post(AUTH_ROUTES.signOut, {});
}
