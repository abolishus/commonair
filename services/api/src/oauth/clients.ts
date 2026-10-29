// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Client authentication against `oauth_apps` (RFC 6749 §2.3, OAuth 2.1 §2.4). */
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { sha256Hex, timingSafeEqual } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { OAuthError, type ClientCredentials } from "./protocol.ts";

export type OAuthAppRow = typeof schema.oauthApps.$inferSelect;

/** Hash compared when the client is unknown or public, so every path does the same work. */
const DUMMY_HASH = "0".repeat(64);

/**
 * Confidential apps must present their secret (Basic or post); public apps send `client_id` only
 * and must not send a secret. Unknown client, wrong secret, a secret from a public client, a
 * missing secret from a confidential one and a suspended app are all `invalid_client`.
 */
export async function authenticateClient(deps: Deps, creds: ClientCredentials): Promise<OAuthAppRow> {
  const basicChallenge = creds.method === "basic";
  const fail = (description: string) => new OAuthError("invalid_client", description, { basicChallenge });
  const [app] =
    creds.clientId.length <= 64
      ? await deps.db.select().from(schema.oauthApps).where(eq(schema.oauthApps.clientId, creds.clientId)).limit(1)
      : [];
  const presented = creds.secret === null ? DUMMY_HASH : await sha256Hex(creds.secret);
  const secretOk = timingSafeEqual(presented, app?.clientSecretHash ?? DUMMY_HASH) && creds.secret !== null;
  if (!app) throw fail("Client authentication failed");
  if (app.confidential) {
    if (creds.secret === null) throw fail("This client must authenticate with its secret");
    if (!secretOk) throw fail("Client authentication failed");
  } else if (creds.secret !== null) throw fail("A public client must not send a client secret");
  if (app.suspendedAt) throw fail("This client is suspended");
  return app;
}
