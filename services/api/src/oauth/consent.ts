// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Consent for the authorization-code flow and device activation, behind `developer.oauth.*`, and
 * the grant listing behind `developer.grants.*` (ADR 0027 §1-2). The web consent and activation
 * pages (E9-consent) are thin clients of these.
 */
import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  OAUTH_LIMITS,
  PKCE_CHALLENGE,
  normalizeUserCode,
  parseScope,
  redirectUriMatches,
} from "@commonair/contracts/oauth";
import { SCOPE_NAMES, type Scope } from "@commonair/contracts/scopes";
import { schema } from "@commonair/db";
import { randomTokenSecret, sha256Hex } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { apiError, notFound, precondition } from "../lib/errors.ts";
import { iso } from "../lib/dto.ts";
import { buildRedirect } from "./protocol.ts";
import { liveToken } from "./tokens.ts";

const { oauthApps, oauthCodes, oauthTokens, oauthDeviceCodes, users } = schema;

export interface AppSummary {
  id: string;
  name: string;
  description: string;
  clientId: string;
  owner: { id: string; username: string };
}

async function appByClientId(deps: Deps, clientId: string) {
  const [row] = await deps.db
    .select({ app: oauthApps, ownerUsername: users.username })
    .from(oauthApps)
    .innerJoin(users, eq(users.id, oauthApps.ownerId))
    .where(eq(oauthApps.clientId, clientId))
    .limit(1);
  return row ?? null;
}

const summary = (app: typeof oauthApps.$inferSelect, ownerUsername: string): AppSummary => ({
  id: app.id,
  name: app.name,
  description: app.description,
  clientId: app.clientId,
  owner: { id: app.ownerId, username: ownerUsername },
});

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  state?: string | undefined;
  codeChallenge?: string | undefined;
  codeChallengeMethod?: string | undefined;
}

export type CheckedRequest =
  | { kind: "consent"; app: typeof oauthApps.$inferSelect; summary: AppSummary; scopes: Scope[] }
  | { kind: "redirect"; redirectTo: string };

/**
 * RFC 6749 §4.1.2.1 order: problems with the client or the redirect URI never redirect (they
 * throw for the page to show); once the redirect URI is known good, every other problem goes back
 * to the client as `error` + `state` on it.
 */
export async function checkAuthorizationRequest(deps: Deps, r: AuthorizationRequest): Promise<CheckedRequest> {
  const found = await appByClientId(deps, r.clientId);
  if (!found) throw notFound("Unknown client (invalid_client)");
  if (found.app.suspendedAt) throw precondition("app_suspended", "This app is suspended");
  if (!found.app.redirectUris.some((registered) => redirectUriMatches(registered, r.redirectUri)))
    throw precondition("invalid_redirect_uri", "The redirect URI is not registered for this app");
  const back = (error: string, description: string): CheckedRequest => ({
    kind: "redirect",
    redirectTo: buildRedirect(r.redirectUri, { error, error_description: description, state: r.state }),
  });
  if (r.responseType !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
  if (r.codeChallenge === undefined || !PKCE_CHALLENGE.test(r.codeChallenge) || r.codeChallengeMethod !== "S256")
    return back("invalid_request", "PKCE S256 is required");
  const scope = parseScope(r.scope);
  if (!scope.ok) return back("invalid_scope", "Unknown scope requested");
  if (scope.scopes.length === 0) return back("invalid_scope", "At least one scope is required");
  return { kind: "consent", app: found.app, summary: summary(found.app, found.ownerUsername), scopes: scope.scopes };
}

/** Whether the user's live tokens for this app together cover every scope. */
export async function grantCovers(deps: Deps, appId: string, userId: string, scopes: readonly Scope[]) {
  const rows = await deps.db
    .select({ scopes: oauthTokens.scopes })
    .from(oauthTokens)
    .where(and(eq(oauthTokens.appId, appId), eq(oauthTokens.userId, userId), liveToken(deps.now())));
  const held = new Set(rows.flatMap((r) => r.scopes));
  return rows.length > 0 && scopes.every((s) => held.has(s));
}

/** Approve: a one-time `cac_` code bound to the exact presented redirect URI and the PKCE challenge. */
export async function issueCode(
  deps: Deps,
  t: { appId: string; userId: string; scopes: Scope[]; redirectUri: string; codeChallenge: string },
): Promise<string> {
  const code = randomTokenSecret("cac_");
  const now = deps.now();
  await deps.db.insert(oauthCodes).values({
    codeHash: await sha256Hex(code),
    appId: t.appId,
    userId: t.userId,
    scopes: t.scopes,
    redirectUri: t.redirectUri,
    codeChallenge: t.codeChallenge,
    codeChallengeMethod: "S256",
    expiresAt: new Date(now.getTime() + OAUTH_LIMITS.codeTtlSeconds * 1000),
    createdAt: now,
  });
  return code;
}

const userCodeHash = async (raw: string) => {
  const normalized = normalizeUserCode(raw);
  return normalized.length === 8 ? sha256Hex(normalized) : null;
};

/** `developer.oauth.activation`: unknown → NOT_FOUND; expired or decided → `expired` (the page tells them apart). */
export async function lookupDevice(deps: Deps, rawUserCode: string) {
  const hash = await userCodeHash(rawUserCode);
  if (!hash) throw notFound("Unknown code");
  const [row] = await deps.db
    .select({ code: oauthDeviceCodes, app: oauthApps, ownerUsername: users.username })
    .from(oauthDeviceCodes)
    .innerJoin(oauthApps, eq(oauthApps.id, oauthDeviceCodes.appId))
    .innerJoin(users, eq(users.id, oauthApps.ownerId))
    .where(eq(oauthDeviceCodes.userCodeHash, hash))
    .limit(1);
  if (!row) throw notFound("Unknown code");
  if (row.code.status !== "pending" || row.code.expiresAt <= deps.now())
    throw precondition("expired", "This code expired or was already used");
  const known = new Set<string>(SCOPE_NAMES);
  return {
    app: summary(row.app, row.ownerUsername),
    scopes: row.code.scopes.filter((s): s is Scope => known.has(s)),
    expiresAt: iso(row.code.expiresAt),
  };
}

/** `developer.oauth.activate`: CAS `pending` → `approved`/`denied`; anything else is CONFLICT. */
export async function decideDevice(deps: Deps, rawUserCode: string, userId: string, approve: boolean) {
  const hash = await userCodeHash(rawUserCode);
  if (!hash) throw notFound("Unknown code");
  const now = deps.now();
  const [row] = await deps.db
    .update(oauthDeviceCodes)
    .set({ status: approve ? "approved" : "denied", userId, decidedAt: now })
    .where(
      and(
        eq(oauthDeviceCodes.userCodeHash, hash),
        eq(oauthDeviceCodes.status, "pending"),
        gt(oauthDeviceCodes.expiresAt, now),
      ),
    )
    .returning({ appId: oauthDeviceCodes.appId });
  if (row) {
    deps.logger.info("oauth device decided", { appId: row.appId, approve });
    return;
  }
  const [exists] = await deps.db
    .select({ id: oauthDeviceCodes.id })
    .from(oauthDeviceCodes)
    .where(eq(oauthDeviceCodes.userCodeHash, hash))
    .limit(1);
  if (!exists) throw notFound("Unknown code");
  throw apiError("CONFLICT", "This code expired or was already decided");
}

/**
 * `developer.grants.list`: one entry per app the user holds a live token for. Scopes are the union
 * of the live tokens'; `authorizedAt` the earliest token of the live families (rotation keeps the
 * family), `lastUsedAt` the latest use across them.
 */
export async function listGrants(deps: Deps, userId: string) {
  const live = await deps.db
    .select({ t: oauthTokens, app: oauthApps, ownerUsername: users.username })
    .from(oauthTokens)
    .innerJoin(oauthApps, eq(oauthApps.id, oauthTokens.appId))
    .innerJoin(users, eq(users.id, oauthApps.ownerId))
    .where(and(isNotNull(oauthTokens.appId), eq(oauthTokens.userId, userId), liveToken(deps.now())));
  const families = [...new Set(live.map((r) => r.t.familyId).filter((f): f is string => f !== null))];
  const history =
    families.length === 0
      ? []
      : await deps.db
          .select({
            appId: oauthTokens.appId,
            createdAt: oauthTokens.createdAt,
            lastUsedAt: oauthTokens.lastUsedAt,
          })
          .from(oauthTokens)
          .where(and(inArray(oauthTokens.familyId, families), eq(oauthTokens.userId, userId)));
  const known = new Set<string>(SCOPE_NAMES);
  const byApp = new Map<string, { app: AppSummary; scopes: Set<Scope>; authorizedAt: Date; lastUsedAt: Date | null }>();
  const touch = (appId: string, createdAt: Date, lastUsedAt: Date | null) => {
    const g = byApp.get(appId);
    if (!g) return;
    if (createdAt < g.authorizedAt) g.authorizedAt = createdAt;
    if (lastUsedAt && (!g.lastUsedAt || lastUsedAt > g.lastUsedAt)) g.lastUsedAt = lastUsedAt;
  };
  for (const { t, app, ownerUsername } of live) {
    let g = byApp.get(app.id);
    if (!g) {
      g = { app: summary(app, ownerUsername), scopes: new Set(), authorizedAt: t.createdAt, lastUsedAt: null };
      byApp.set(app.id, g);
    }
    for (const s of t.scopes) if (known.has(s)) g.scopes.add(s as Scope);
    touch(app.id, t.createdAt, t.lastUsedAt);
  }
  for (const h of history) if (h.appId) touch(h.appId, h.createdAt, h.lastUsedAt);
  return [...byApp.values()]
    .sort((a, b) => b.authorizedAt.getTime() - a.authorizedAt.getTime())
    .map((g) => ({
      app: g.app,
      scopes: SCOPE_NAMES.filter((s) => g.scopes.has(s)),
      authorizedAt: iso(g.authorizedAt),
      lastUsedAt: g.lastUsedAt ? iso(g.lastUsedAt) : null,
    }));
}

/** Codes not yet exchanged for this grant: a revoked grant must not come back through them. */
export const pendingCodesOf = (appId: string, userId: string) =>
  and(eq(oauthCodes.appId, appId), eq(oauthCodes.userId, userId), isNull(oauthCodes.redeemedAt));
