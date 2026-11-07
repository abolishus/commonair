// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The search params of `/signin` and `/signup` (F17): where to go afterwards and the password
 * reset link's landing. `?redirect=` is where the visitor came from (the header's links set it);
 * `?returnTo=` is the route guards' (an OAuth consent page). Both are same-origin paths only:
 * anything else is dropped, never followed. An open redirect is a bug.
 */
import { api } from "./api.ts";
import { DEFAULT_LANDING } from "./auth.ts";
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

/** The studio: where an account that streams lands after signing in without a target. */
export const STUDIO_LANDING = "/dashboard";

/** How long sign-in waits to learn whether the account streams before going home anyway. */
export const LANDING_PROBE_MS = 3000;

/** What sign-in asks the API to tell a creator from a viewer (injectable for tests). */
export interface LandingProbe {
  /** The signed-in account's channel slug, or null. */
  channelSlug: () => Promise<string | null>;
  /** That channel's stream keys, revoked ones included: one exists once the account set up streaming. */
  streamKeyCount: (channel: string) => Promise<number>;
}

const apiProbe: LandingProbe = {
  channelSlug: async () => (await api().me.get()).channelSlug,
  streamKeyCount: async (channel) => (await api().stream.keys({ channel })).length,
};

/**
 * Where sign-in goes (F11): the visitor's target (`returnTo`, else `redirect`) when there is one;
 * otherwise the studio only for an account that has created a stream key (every account that has
 * streamed has one), and home for everyone else. A failure or a slow answer means home: a viewer
 * must never land in the studio, and a creator is one click from it.
 */
export async function signInLanding(
  target: string | undefined,
  probe: LandingProbe = apiProbe,
  timeoutMs = LANDING_PROBE_MS,
): Promise<string> {
  const safe = safeRedirect(target);
  if (safe !== undefined) return safe;
  const ask = (async () => {
    const slug = await probe.channelSlug();
    if (!slug) return DEFAULT_LANDING;
    return (await probe.streamKeyCount(slug)) > 0 ? STUDIO_LANDING : DEFAULT_LANDING;
  })().catch(() => DEFAULT_LANDING);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(DEFAULT_LANDING), timeoutMs);
  });
  try {
    return await Promise.race([ask, late]);
  } finally {
    clearTimeout(timer);
  }
}
