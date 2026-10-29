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

/**
 * TanStack's default search parser turns `123` into a number and `true` into a boolean, so a
 * value comes back to a string here; an unusable one is dropped rather than failing the route.
 */
const param = z
  .preprocess((v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v), z.string().max(MAX).optional())
  .catch(undefined);

export const AuthorizeSearch = z.object({
  client_id: param,
  redirect_uri: param,
  response_type: param,
  scope: param,
  state: param,
  code_challenge: param,
  code_challenge_method: param,
  force_verify: param,
});
export type AuthorizeSearch = z.infer<typeof AuthorizeSearch>;

/** The route's `validateSearch`: only the OAuth names, each a string or absent. */
export function validateAuthorizeSearch(search: Record<string, unknown>): AuthorizeSearch {
  const parsed = AuthorizeSearch.parse(search);
  // Drop absent keys, so the URL the router rebuilds carries nothing the app did not send.
  return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)) as AuthorizeSearch;
}

/**
 * The query exactly as the app sent it. The router's parsed search is not exact (`"abc"` loses
 * its quotes, `007` becomes 7), and `state` must come back to the app byte for byte, so the page
 * reads the raw query string.
 */
export function authorizeQueryFrom(searchStr: string): AuthorizeSearch {
  const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
  const raw: Record<string, string> = {};
  for (const key of Object.keys(AuthorizeSearch.shape)) {
    const v = params.get(key);
    if (v !== null) raw[key] = v;
  }
  return validateAuthorizeSearch(raw);
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
