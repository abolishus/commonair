// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The query an app puts on `/oauth2/authorize` (RFC 6749 §4.1.1, RFC 7636 §4.3, Twitch's
 * `force_verify`). Every value is an optional, bounded string; unknown parameters are ignored. The
 * API checks the values themselves (`developer.oauth.request`), so the bounds here only keep
 * absurd input out of memory: they are looser than the API's.
 */
import { z } from "zod";
import type { ConsentRequestInput } from "./shared.ts";

/** Longer than any value the API accepts (redirect URI 2000, scope 2000). */
const MAX = 4096;

/** One value of the raw query: a bounded string, or absent. */
const param = z.string().max(MAX).optional().catch(undefined);

/** Every OAuth parameter the page reads; anything else in the query is ignored. */
const KEYS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "force_verify",
] as const;
type Key = (typeof KEYS)[number];

export const AuthorizeSearch = z.object(Object.fromEntries(KEYS.map((k) => [k, param])) as Record<Key, typeof param>);
export type AuthorizeSearch = z.infer<typeof AuthorizeSearch>;

/**
 * A value as TanStack's default search parser hands it over: `123` arrives as a number and `true`
 * as a boolean. Kept exactly as parsed, never turned back into a string: the router rebuilds the
 * canonical URL from this, and a string that reads as JSON would come back quoted
 * (`force_verify=%22true%22`), so a converted value breaks the app's query and causes a redirect.
 */
const routeParam = z
  .union([z.string().max(MAX), z.number(), z.boolean()])
  .optional()
  .catch(undefined);
const AuthorizeRouteSearch = z.object(
  Object.fromEntries(KEYS.map((k) => [k, routeParam])) as Record<Key, typeof routeParam>,
);
export type AuthorizeRouteSearch = z.infer<typeof AuthorizeRouteSearch>;

/**
 * The route's `validateSearch`: an identity on the OAuth names (as the router parsed them), so the
 * URL the router rebuilds matches the one the app sent. The page never reads this: it reads the
 * raw query (`authorizeQueryFrom`).
 */
export function validateAuthorizeSearch(search: Record<string, unknown>): AuthorizeRouteSearch {
  const parsed = AuthorizeRouteSearch.parse(search);
  // Drop absent keys, so the URL the router rebuilds carries nothing the app did not send.
  return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)) as AuthorizeRouteSearch;
}

/**
 * The query exactly as the app sent it. The router's parsed search is not exact (`"abc"` loses
 * its quotes, `007` becomes 7), and `state` must come back to the app byte for byte, so the page
 * reads the raw query string.
 */
export function authorizeQueryFrom(searchStr: string): AuthorizeSearch {
  const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
  const raw: Record<string, string> = {};
  for (const key of KEYS) {
    const v = params.get(key);
    if (v !== null) raw[key] = v;
  }
  const parsed = AuthorizeSearch.parse(raw);
  return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)) as AuthorizeSearch;
}

/** Twitch's convention: only the literal `true` forces the consent screen. */
export const forcesVerify = (q: AuthorizeSearch): boolean => q.force_verify === "true";

/**
 * What `developer.oauth.request` gets, or why the page cannot even ask: without a client id there
 * is no app to name, without a redirect URI nowhere to go back to (never a redirect, RFC 6749
 * §4.1.2.1).
 */
export function requestInput(
  q: AuthorizeSearch,
): { ok: true; input: ConsentRequestInput } | { ok: false; error: "invalid_client" | "invalid_redirect_uri" } {
  if (!q.client_id) return { ok: false, error: "invalid_client" };
  if (!q.redirect_uri) return { ok: false, error: "invalid_redirect_uri" };
  return {
    ok: true,
    input: {
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      responseType: q.response_type ?? "",
      scope: q.scope ?? "",
      ...(q.state === undefined ? {} : { state: q.state }),
      ...(q.code_challenge === undefined ? {} : { codeChallenge: q.code_challenge }),
      ...(q.code_challenge_method === undefined ? {} : { codeChallengeMethod: q.code_challenge_method }),
      forceVerify: forcesVerify(q),
    },
  };
}
