// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * RFC 8058 one-click unsubscribe (ADR 0028 decision 4, Amendment 1): the `List-Unsubscribe` URL of
 * every notification email. A raw route, not an oRPC procedure: mail clients POST with no session,
 * no origin and a form body. HTTP 501 until N1-email implements it.
 */
import { EMAIL_UNSUBSCRIBE_PATH } from "@commonair/contracts/notify";
import type { Deps } from "../deps.ts";

export const isEmailUnsubscribePath = (path: string): boolean => path === EMAIL_UNSUBSCRIBE_PATH;

/** GET: 303 to the confirm page with the same query. POST (RFC 8058 one-click): apply and answer 200. */
export async function emailUnsubscribe(
  _deps: Deps,
  _raw: Request,
  _url: URL,
  _rateLimitHash: string,
): Promise<Response> {
  return new Response(null, { status: 501 });
}
