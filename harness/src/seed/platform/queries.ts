// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The query strings seed-platform publishes for `SEED_ROUTES` (without the leading `?`). Pure. */
import { UNSUBSCRIBE_LISTS } from "@commonair/contracts/enums";
import type { Scope } from "@commonair/contracts/scopes";

/** `/oauth2/authorize`: everything an app sends (RFC 6749 §4.1.1, RFC 7636 §4.3). */
export function buildAuthorizeQuery(o: {
  clientId: string;
  redirectUri: string;
  scopes: readonly Scope[];
  state: string;
  codeChallenge: string;
}): string {
  return new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: o.scopes.join(" "),
    state: o.state,
    code_challenge: o.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
}

/** `/activate?code=XXXX-XXXX`, as `verification_uri_complete` prefills it. */
export function buildActivateQuery(userCode: string): string {
  return new URLSearchParams({ code: userCode }).toString();
}

/**
 * The confirm page's query from a mailed one-click link (`…/api/email/unsubscribe?list=…&token=…`):
 * the same `list` and `token`, or null when the link is not one.
 */
export function parseUnsubscribeLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const list = url.searchParams.get("list");
  const token = url.searchParams.get("token");
  if (!list || !token || !(UNSUBSCRIBE_LISTS as readonly string[]).includes(list)) return null;
  return new URLSearchParams({ list, token }).toString();
}
