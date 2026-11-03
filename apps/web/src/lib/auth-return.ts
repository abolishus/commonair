// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The search params of `/signin` and `/signup` (F17): where to go afterwards and the password
 * reset link's landing. `?redirect=` is where the visitor came from (the header's links set it);
 * `?returnTo=` is the route guards' (an OAuth consent page). Both are same-origin paths only:
 * anything else is dropped, never followed. An open redirect is a bug.
 */
import { safeReturnTo } from "./guard.ts";

/** Any origin works: a relative path keeps whatever base it is resolved against. */
const PROBE_ORIGIN = "https://commonair.invalid";

/**
 * A same-origin, path-only target, or undefined. On top of the contract's path rule (a single
 * leading `/`, no whitespace, no backslash), the URL parser must agree it stays on this origin.
 */
export function safeRedirect(value: unknown): string | undefined {
  const path = safeReturnTo(value);
  if (path === undefined) return undefined;
  try {
    const url = new URL(path, PROBE_ORIGIN);
    return url.origin === PROBE_ORIGIN ? path : undefined;
  } catch {
    return undefined;
  }
}

export interface AuthSearch {
  returnTo?: string;
  redirect?: string;
  /** The reset link's token (`/signin?token=`), set by the API's redirect. */
  token?: string;
  /** `INVALID_TOKEN` from the API's redirect when the reset link expired or was used. */
  error?: string;
}

const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;
const ERROR = /^[A-Z_]{1,64}$/;

/** `validateSearch` for `/signin` and `/signup`: a bad value is dropped, not an error page. */
export function authSearch(search: Record<string, unknown>): AuthSearch {
  const out: AuthSearch = {};
  const returnTo = safeRedirect(search.returnTo);
  if (returnTo !== undefined) out.returnTo = returnTo;
  const redirect = safeRedirect(search.redirect);
  if (redirect !== undefined) out.redirect = redirect;
  if (typeof search.token === "string" && TOKEN.test(search.token)) out.token = search.token;
  if (typeof search.error === "string" && ERROR.test(search.error)) out.error = search.error;
  return out;
}

/** Where sign-in (or the verification link) goes: the guard's `returnTo`, else `redirect`. */
export function authTarget(search: Pick<AuthSearch, "returnTo" | "redirect">): string | undefined {
  return safeRedirect(search.returnTo) ?? safeRedirect(search.redirect);
}

/** The search to carry between `/signin` and `/signup`, so switching forms keeps the target. */
export function carriedSearch(search: Pick<AuthSearch, "returnTo" | "redirect">): {
  returnTo?: string;
  redirect?: string;
} {
  const out: { returnTo?: string; redirect?: string } = {};
  const returnTo = safeRedirect(search.returnTo);
  if (returnTo !== undefined) out.returnTo = returnTo;
  const redirect = safeRedirect(search.redirect);
  if (redirect !== undefined) out.redirect = redirect;
  return out;
}
