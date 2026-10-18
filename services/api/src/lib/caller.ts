// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Resolve who is calling: a better-auth session cookie or an OAuth bearer token. */
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { SCOPE_NAMES, type Scope } from "@commonair/contracts/scopes";
import { schema } from "@commonair/db";
import { sha256Hex } from "@commonair/tokens";
import type { Auth } from "../auth/index.ts";
import type { Deps } from "../deps.ts";
import type { Caller, CallerUser } from "./access.ts";

const { users, oauthTokens } = schema;
type UserRow = typeof users.$inferSelect;

export const isSuspended = (u: Pick<UserRow, "banned" | "banExpires">, now: Date) =>
  u.banned && (u.banExpires === null || u.banExpires > now);

export const toCallerUser = (u: UserRow, now: Date): CallerUser => ({
  id: u.id,
  username: u.username,
  role: u.role,
  accountType: u.accountType,
  suspended: isSuspended(u, now),
});

export function bearerToken(headers: Headers): string | null {
  const h = headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

const LAST_USED_RESOLUTION_MS = 60_000;

export async function resolveToken(deps: Deps, token: string): Promise<Caller | null> {
  const now = deps.now();
  const hash = await sha256Hex(token);
  const [row] = await deps.db
    .select({ token: oauthTokens, user: users })
    .from(oauthTokens)
    .innerJoin(users, eq(users.id, oauthTokens.userId))
    .where(and(eq(oauthTokens.accessTokenHash, hash), isNull(oauthTokens.revokedAt), gt(oauthTokens.expiresAt, now)))
    .limit(1);
  if (!row || row.user.deletedAt) return null;
  // Throttled so a busy bot does not turn every request into a write.
  if (!row.token.lastUsedAt || now.getTime() - row.token.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS)
    await deps.db
      .update(oauthTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(oauthTokens.id, row.token.id),
          or(
            isNull(oauthTokens.lastUsedAt),
            lt(oauthTokens.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)),
          ),
        ),
      );
  const known = new Set<string>(SCOPE_NAMES);
  return {
    kind: "token",
    user: toCallerUser(row.user, now),
    tokenId: row.token.id,
    appId: row.token.appId,
    scopes: row.token.scopes.filter((s): s is Scope => known.has(s)),
    expiresAt: row.token.expiresAt,
  };
}

export async function resolveSession(deps: Deps, auth: Auth, headers: Headers): Promise<Caller | null> {
  if (!headers.get("cookie")) return null;
  const s = await auth.api.getSession({ headers });
  if (!s) return null;
  const [u] = await deps.db.select().from(users).where(eq(users.id, s.user.id)).limit(1);
  if (!u || u.deletedAt) return null;
  return { kind: "session", user: toCallerUser(u, deps.now()), sessionId: s.session.id };
}

/** Bearer wins over cookies; an invalid bearer is reported (the caller asked to be someone). */
export async function resolveCaller(
  deps: Deps,
  auth: Auth,
  headers: Headers,
): Promise<{ caller: Caller | null; invalidBearer: boolean }> {
  const token = bearerToken(headers);
  if (token) {
    const caller = await resolveToken(deps, token);
    return { caller, invalidBearer: caller === null };
  }
  return { caller: await resolveSession(deps, auth, headers), invalidBearer: false };
}
