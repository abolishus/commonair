// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SignInReturnPath } from "@commonair/contracts/oauth";
import { redirect } from "@tanstack/react-router";
import type { SessionUser } from "./bootstrap-types.ts";

/**
 * Where to go after signing in (or after the verification link): a same-origin relative path only.
 * Protocol-relative (`//evil`), absolute and backslash paths are dropped, never followed.
 */
export function safeReturnTo(value: unknown): string | undefined {
  const parsed = SignInReturnPath.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** `validateSearch` for `/signin` and `/signup`: a bad `returnTo` is dropped, not an error page. */
export function returnToSearch(search: Record<string, unknown>): { returnTo?: string } {
  const returnTo = safeReturnTo(search.returnTo);
  return returnTo === undefined ? {} : { returnTo };
}

/**
 * Route guard for signed-in pages: resolves the session (on the server during SSR) and redirects
 * to /signin without rendering anything when there is none. With `returnTo` (a route passes
 * `location.href` from `beforeLoad`'s argument: the guard cannot see the location), sign-in comes
 * back to it, e.g. to an OAuth consent page (ADR 0027).
 */
export async function requireSession(
  load: () => Promise<SessionUser | null>,
  opts: { returnTo?: string } = {},
): Promise<{ me: SessionUser }> {
  const me = await load();
  if (!me) {
    const returnTo = safeReturnTo(opts.returnTo);
    throw redirect({ to: "/signin", search: returnTo === undefined ? {} : { returnTo }, replace: true });
  }
  return { me };
}
