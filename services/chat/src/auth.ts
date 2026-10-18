// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Connection authentication, decided before the WebSocket upgrade:
 *
 *   ?token=<chat token>            browser clients; HMAC-verified with INTERNAL_API_SECRET
 *   Authorization: Bearer <token>  server-to-server (IRC gateway, bots); an OAuth access token,
 *                                  looked up by SHA-256 in oauth_tokens; needs `chat:read`
 *   neither                        anonymous, read-only
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import { sha256Hex, verifyChatToken } from "@commonair/tokens";
import type { Identity } from "./types.ts";

export type AuthResult = { ok: true; identity: Identity } | { ok: false; status: 401 | 403; error: string };

export const ANONYMOUS: Identity = { userId: null, scopes: [], appId: null, via: "anonymous" };

export async function authenticate(req: Request, db: Database, internalSecret: string): Promise<AuthResult> {
  const token = new URL(req.url).searchParams.get("token");
  const header = req.headers.get("authorization");
  if (token) {
    const claims = await verifyChatToken(internalSecret, token);
    if (!claims) return { ok: false, status: 401, error: "invalid_token" };
    if (claims.uid === null) return { ok: true, identity: ANONYMOUS };
    return { ok: true, identity: { userId: claims.uid, scopes: claims.scopes, appId: claims.app, via: "token" } };
  }
  if (header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m?.[1]) return { ok: false, status: 401, error: "invalid_authorization" };
    const hash = await sha256Hex(m[1]);
    const [row] = await db
      .select({
        id: schema.oauthTokens.id,
        userId: schema.oauthTokens.userId,
        appId: schema.oauthTokens.appId,
        scopes: schema.oauthTokens.scopes,
      })
      .from(schema.oauthTokens)
      .where(
        and(
          eq(schema.oauthTokens.accessTokenHash, hash),
          isNull(schema.oauthTokens.revokedAt),
          gt(schema.oauthTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) return { ok: false, status: 401, error: "invalid_token" };
    if (!row.scopes.includes("chat:read")) return { ok: false, status: 403, error: "insufficient_scope" };
    // Best effort: last-use tracking must never block or fail a connection.
    void db
      .update(schema.oauthTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.oauthTokens.id, row.id))
      .then(
        () => {},
        () => {},
      );
    return { ok: true, identity: { userId: row.userId, scopes: row.scopes, appId: row.appId, via: "oauth" } };
  }
  return { ok: true, identity: ANONYMOUS };
}
