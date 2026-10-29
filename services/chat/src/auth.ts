// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Connection authentication, decided before the WebSocket upgrade:
 *
 *   ?token=<chat token>            browser clients; HMAC-verified with INTERNAL_API_SECRET
 *   Authorization: Bearer <token>  server-to-server (IRC gateway, bots); an OAuth access token,
 *                                  looked up by SHA-256 in oauth_tokens; needs `chat:read`
 *   neither                        anonymous, read-only
 *
 * Credentials are not trusted for the socket's lifetime: sockets close when their token
 * expires, and OAuth tokens are re-checked (through a short cache) before every send/command.
 */
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import { sha256Hex, verifyChatToken } from "@commonair/tokens";
import { TtlCache } from "./cache.ts";
import type { Identity } from "./types.ts";

export type AuthResult = { ok: true; identity: Identity } | { ok: false; status: 401 | 403; error: string };

export const ANONYMOUS: Identity = {
  userId: null,
  scopes: [],
  appId: null,
  via: "anonymous",
  expiresAt: null,
  tokenHash: null,
};

interface OauthRow {
  id: string;
  userId: string;
  appId: string | null;
  scopes: string[];
  expiresAt: Date;
}

async function findOauthToken(db: Database, hash: string): Promise<OauthRow | null> {
  const t = schema.oauthTokens;
  const a = schema.oauthApps;
  const [row] = await db
    .select({ id: t.id, userId: t.userId, appId: t.appId, scopes: t.scopes, expiresAt: t.expiresAt })
    .from(t)
    .leftJoin(a, eq(a.id, t.appId))
    .where(
      and(
        eq(t.accessTokenHash, hash),
        isNull(t.revokedAt),
        gt(t.expiresAt, new Date()),
        // App-only (client credentials) tokens act for no user, so they cannot chat (ADR 0027).
        isNotNull(t.userId),
        // A suspended app's tokens are revoked with the suspension; this is defence in depth.
        isNull(a.suspendedAt),
      ),
    )
    .limit(1);
  if (!row || row.userId === null) return null;
  return { ...row, userId: row.userId };
}

export class Authenticator {
  /** tokenHash → whether it is still valid; bounds how long a revoked token keeps working. */
  private readonly oauthValid: TtlCache<string, boolean>;

  constructor(
    private readonly db: Database,
    private readonly internalSecret: string,
    revalidateMs = 30_000,
  ) {
    this.oauthValid = new TtlCache(revalidateMs, 50_000);
  }

  async authenticate(req: Request): Promise<AuthResult> {
    const token = new URL(req.url).searchParams.get("token");
    const header = req.headers.get("authorization");
    if (token) {
      const claims = await verifyChatToken(this.internalSecret, token);
      if (!claims) return { ok: false, status: 401, error: "invalid_token" };
      if (claims.uid === null) return { ok: true, identity: { ...ANONYMOUS, expiresAt: claims.exp * 1000 } };
      return {
        ok: true,
        identity: {
          userId: claims.uid,
          scopes: claims.scopes,
          appId: claims.app,
          via: "token",
          expiresAt: claims.exp * 1000,
          tokenHash: null,
        },
      };
    }
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (!m?.[1]) return { ok: false, status: 401, error: "invalid_authorization" };
      const hash = await sha256Hex(m[1]);
      const row = await findOauthToken(this.db, hash);
      if (!row) return { ok: false, status: 401, error: "invalid_token" };
      if (!row.scopes.includes("chat:read")) return { ok: false, status: 403, error: "insufficient_scope" };
      // Best effort: last-use tracking must never block or fail a connection.
      void this.db
        .update(schema.oauthTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.oauthTokens.id, row.id))
        .then(
          () => {},
          () => {},
        );
      return {
        ok: true,
        identity: {
          userId: row.userId,
          scopes: row.scopes,
          appId: row.appId,
          via: "oauth",
          expiresAt: row.expiresAt.getTime(),
          tokenHash: hash,
        },
      };
    }
    return { ok: true, identity: ANONYMOUS };
  }

  /** Whether the socket's credentials are still good right now (expiry, and OAuth revocation). */
  async stillValid(identity: Identity, now = Date.now()): Promise<boolean> {
    if (identity.expiresAt !== null && identity.expiresAt <= now) return false;
    if (identity.via !== "oauth" || !identity.tokenHash) return true;
    const hash = identity.tokenHash;
    return this.oauthValid.get(hash, async () => (await findOauthToken(this.db, hash)) !== null);
  }

  /** Forget cached validity (a revocation arrived on BUS.userControl). */
  forget(tokenHash: string): void {
    this.oauthValid.delete(tokenHash);
  }
}
