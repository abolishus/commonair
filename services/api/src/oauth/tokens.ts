// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Token issuance for the authorization-code, refresh-token and client-credentials grants (RFC 6749
 * §4.1, §6, §4.4; OAuth 2.1 §4.1.3, §4.3.1). Secrets are minted with `randomTokenSecret`
 * (lowercase: IRC clients lowercase tokens) and stored as sha256 only.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { OAUTH_LIMITS, pkceChallenge, type TokenResponse } from "@commonair/contracts/oauth";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { randomTokenSecret, sha256Hex, timingSafeEqual } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { publishRevocations, revokeTokensInTx, type RevokedToken } from "../developer/grants.ts";
import type { OAuthAppRow } from "./clients.ts";
import { OAuthError } from "./protocol.ts";

const { oauthTokens, oauthCodes, users } = schema;

type TokenKind = "authorization_code" | "device_code" | "client_credentials";

const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

/** Insert one `oauth_tokens` row and answer the RFC 6749 §5.1 body. */
export async function issueToken(
  tx: Executor,
  now: Date,
  t: { appId: string; userId: string | null; kind: TokenKind; scopes: string[]; familyId: string | null },
): Promise<TokenResponse> {
  const accessToken = randomTokenSecret("ca_");
  const ttl =
    t.kind === "client_credentials" ? OAUTH_LIMITS.clientCredentialsTtlSeconds : OAUTH_LIMITS.accessTokenTtlSeconds;
  const refreshToken = t.familyId === null ? null : randomTokenSecret("car_");
  await tx.insert(oauthTokens).values({
    id: uuidv7(),
    appId: t.appId,
    userId: t.userId,
    kind: t.kind,
    scopes: t.scopes,
    accessTokenHash: await sha256Hex(accessToken),
    refreshTokenHash: refreshToken === null ? null : await sha256Hex(refreshToken),
    refreshExpiresAt: refreshToken === null ? null : addSeconds(now, OAUTH_LIMITS.refreshTokenTtlSeconds),
    familyId: t.familyId,
    expiresAt: addSeconds(now, ttl),
    createdAt: now,
  });
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: ttl,
    ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
    scope: t.scopes.join(" "),
  };
}

/** A user who may still receive tokens: exists and is not deleted. */
export async function userUsable(tx: Executor, userId: string): Promise<boolean> {
  const [u] = await tx.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, userId)).limit(1);
  return u !== undefined && u.deletedAt === null;
}

type Outcome = { ok: true; token: TokenResponse } | { ok: false; error: OAuthError; revoked: RevokedToken[] };

const invalidGrant = (description: string, revoked: RevokedToken[] = []): Outcome => ({
  ok: false,
  error: new OAuthError("invalid_grant", description),
  revoked,
});

async function settle(deps: Deps, outcome: Outcome, grant: string, appId: string): Promise<TokenResponse> {
  if (outcome.ok) {
    deps.logger.info("oauth token issued", { appId, grant });
    return outcome.token;
  }
  if (outcome.revoked.length > 0) {
    deps.logger.warn("oauth token family revoked on reuse", { appId, grant, tokens: outcome.revoked.length });
    await publishRevocations(deps, outcome.revoked, "token_revoked");
  }
  throw outcome.error;
}

/**
 * `authorization_code`: redeem the code by CAS on `redeemed_at` (a code is presented once, even
 * when the exchange then fails). A code presented again revokes every token its first redemption
 * issued (OAuth 2.1 §4.1.3). App, redirect URI and the PKCE verifier must all match.
 */
export async function authorizationCodeGrant(
  deps: Deps,
  app: OAuthAppRow,
  req: { code: string; redirect_uri: string; code_verifier: string },
): Promise<TokenResponse> {
  const now = deps.now();
  const codeHash = await sha256Hex(req.code);
  const challenge = await pkceChallenge(req.code_verifier);
  const outcome = await deps.db.transaction(async (tx): Promise<Outcome> => {
    const familyId = uuidv7();
    const [code] = await tx
      .update(oauthCodes)
      .set({ redeemedAt: now, familyId })
      .where(and(eq(oauthCodes.codeHash, codeHash), isNull(oauthCodes.redeemedAt), gt(oauthCodes.expiresAt, now)))
      .returning();
    if (!code) {
      const [seen] = await tx
        .select({ familyId: oauthCodes.familyId, redeemedAt: oauthCodes.redeemedAt })
        .from(oauthCodes)
        .where(eq(oauthCodes.codeHash, codeHash))
        .limit(1);
      if (seen?.redeemedAt && seen.familyId) {
        const revoked = await revokeTokensInTx(tx, { familyId: seen.familyId }, now);
        return invalidGrant("The authorization code was already used", revoked);
      }
      return invalidGrant("The authorization code is invalid or expired");
    }
    if (code.appId !== app.id) return invalidGrant("The authorization code was issued to another client");
    if (code.redirectUri !== req.redirect_uri)
      return invalidGrant("redirect_uri does not match the authorization request");
    if (!timingSafeEqual(challenge, code.codeChallenge)) return invalidGrant("The PKCE code_verifier does not match");
    if (!(await userUsable(tx, code.userId))) return invalidGrant("The authorizing user no longer exists");
    const token = await issueToken(tx, now, {
      appId: app.id,
      userId: code.userId,
      kind: "authorization_code",
      scopes: code.scopes,
      familyId,
    });
    return { ok: true, token };
  });
  return settle(deps, outcome, "authorization_code", app.id);
}

/**
 * `refresh_token` with rotation and reuse detection (OAuth 2.1 §4.3.1). Presenting a rotated
 * refresh token revokes the whole family. Two concurrent refreshes of the same live token are not
 * an attack signal: both read it unrotated, one wins the CAS on `rotated_at`, and the loser gets
 * `invalid_grant` without any revocation.
 */
export async function refreshGrant(deps: Deps, app: OAuthAppRow, refreshToken: string): Promise<TokenResponse> {
  const now = deps.now();
  const hash = await sha256Hex(refreshToken);
  const [row] = await deps.db.select().from(oauthTokens).where(eq(oauthTokens.refreshTokenHash, hash)).limit(1);
  if (!row || row.appId !== app.id || row.familyId === null)
    throw new OAuthError("invalid_grant", "The refresh token is invalid");
  const familyId = row.familyId;
  if (row.rotatedAt) {
    const revoked = await deps.db.transaction((tx) => revokeTokensInTx(tx, { familyId }, now));
    return settle(deps, invalidGrant("The refresh token was already used", revoked), "refresh_token", app.id);
  }
  if (row.revokedAt) throw new OAuthError("invalid_grant", "The refresh token was revoked");
  if (!row.refreshExpiresAt || row.refreshExpiresAt <= now)
    throw new OAuthError("invalid_grant", "The refresh token expired");
  if (row.userId === null || (row.kind !== "authorization_code" && row.kind !== "device_code"))
    throw new OAuthError("invalid_grant", "The refresh token is invalid");
  const userId = row.userId;
  const kind = row.kind;

  const { outcome, rotated } = await deps.db.transaction(
    async (tx): Promise<{ outcome: Outcome; rotated: RevokedToken | null }> => {
      const [old] = await tx
        .update(oauthTokens)
        .set({ rotatedAt: now, revokedAt: now })
        .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.rotatedAt), isNull(oauthTokens.revokedAt)))
        .returning({
          id: oauthTokens.id,
          userId: oauthTokens.userId,
          appId: oauthTokens.appId,
          accessTokenHash: oauthTokens.accessTokenHash,
        });
      // Lost the race to a concurrent refresh (or a revocation): no family revocation.
      if (!old) return { outcome: invalidGrant("The refresh token is no longer valid"), rotated: null };
      if (!(await userUsable(tx, userId)))
        return { outcome: invalidGrant("The authorizing user no longer exists"), rotated: null };
      const token = await issueToken(tx, now, { appId: app.id, userId, kind, scopes: row.scopes, familyId });
      return { outcome: { ok: true, token }, rotated: old };
    },
  );
  // The grant lives on: chat closes sockets on the old token, EventSub sessions stay bound.
  if (rotated) await publishRevocations(deps, [rotated], "token_rotated");
  return settle(deps, outcome, "refresh_token", app.id);
}

/** `client_credentials`: an app-only token, no user, no scopes, no refresh token (ADR 0027 §1). */
export async function clientCredentialsGrant(deps: Deps, app: OAuthAppRow): Promise<TokenResponse> {
  const now = deps.now();
  const token = await issueToken(deps.db, now, {
    appId: app.id,
    userId: null,
    kind: "client_credentials",
    scopes: [],
    familyId: null,
  });
  deps.logger.info("oauth token issued", { appId: app.id, grant: "client_credentials" });
  return token;
}

/** RFC 7009: revoke an access token (itself) or a refresh token (its family) of this app. */
export async function revokePresentedToken(
  deps: Deps,
  app: OAuthAppRow,
  token: string,
  hint: "access_token" | "refresh_token" | undefined,
): Promise<void> {
  const hash = await sha256Hex(token);
  const byAccess = () =>
    deps.db
      .select({ id: oauthTokens.id, appId: oauthTokens.appId })
      .from(oauthTokens)
      .where(eq(oauthTokens.accessTokenHash, hash))
      .limit(1)
      .then(([r]) => (r ? { ...r, kind: "access" as const, familyId: null } : null));
  const byRefresh = () =>
    deps.db
      .select({ id: oauthTokens.id, appId: oauthTokens.appId, familyId: oauthTokens.familyId })
      .from(oauthTokens)
      .where(eq(oauthTokens.refreshTokenHash, hash))
      .limit(1)
      .then(([r]) => (r ? { ...r, kind: "refresh" as const } : null));
  // The hint only orders the lookups (RFC 7009 §2.1).
  const found =
    hint === "refresh_token"
      ? ((await byRefresh()) ?? (await byAccess()))
      : ((await byAccess()) ?? (await byRefresh()));
  // Unknown tokens and other apps' tokens are ignored: the answer is 200 either way.
  if (!found || found.appId !== app.id) return;
  const now = deps.now();
  const revoked = await deps.db.transaction((tx) =>
    found.kind === "refresh" && found.familyId
      ? revokeTokensInTx(tx, { familyId: found.familyId }, now)
      : revokeTokensInTx(tx, { tokenIds: [found.id] }, now),
  );
  deps.logger.info("oauth token revoked", { appId: app.id, kind: found.kind, tokens: revoked.length });
  await publishRevocations(deps, revoked, "token_revoked");
}

/** Live means unrevoked with its access or refresh token unexpired. */
export const liveToken = (now: Date) =>
  and(
    isNull(oauthTokens.revokedAt),
    sql`(${oauthTokens.expiresAt} > ${now.toISOString()}::timestamptz or ${oauthTokens.refreshExpiresAt} > ${now.toISOString()}::timestamptz)`,
  );
