// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AUTH_ROUTES } from "@commonair/contracts/auth";

/** better-auth's HTTP surface as services/api mounts it (outside the oRPC contract). */
export { AUTH_ROUTES };

export interface SignUpInput {
  email: string;
  username: string;
  password: string;
  birthDate: string;
  altcha: string;
  acceptedDocumentIds: string[];
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

export function signUp(input: SignUpInput): Promise<void> {
  // The display name starts as the username; `callbackURL` is where the verification link lands.
  return post(AUTH_ROUTES.signUp, { ...input, name: input.username, callbackURL: "/dashboard" });
}

/**
 * Ask for a new verification link. better-auth answers `{ status: true }` (after a constant
 * delay) whether or not the address exists or is already verified, so callers show one neutral
 * confirmation and only treat a rate limit differently.
 */
export function resendVerificationEmail(email: string): Promise<void> {
  return post(AUTH_ROUTES.sendVerificationEmail, { email, callbackURL: "/dashboard" });
}

export function signIn(email: string, password: string): Promise<void> {
  return post(AUTH_ROUTES.signIn, { email, password });
}

export function signOut(): Promise<void> {
  return post(AUTH_ROUTES.signOut, {});
}
