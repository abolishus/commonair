// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer.tokens.*` (E9-oauth): token listing, revocation and Twitch-shaped validation. */
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Scope } from "@commonair/contracts/scopes";
import { schema } from "@commonair/db";
import type { Deps } from "../../deps.ts";
import { publishRevocations, revokeTokensInTx } from "../../developer/grants.ts";
import { bearerToken, resolveBearer } from "../../lib/caller.ts";
import { iso, isoOrNull } from "../../lib/dto.ts";
import { apiError, notFound } from "../../lib/errors.ts";
import { os, requireCaller } from "../../lib/orpc.ts";
import { liveToken } from "../../oauth/tokens.ts";

const { oauthTokens, oauthApps, users } = schema;

/** Tokens a member answers for: their own and their bots' (the owner answers for a bot). */
const answeredBy = (deps: Deps, userId: string) =>
  or(
    eq(oauthTokens.userId, userId),
    inArray(oauthTokens.userId, deps.db.select({ id: users.id }).from(users).where(eq(users.botOwnerId, userId))),
  );

export const tokens = {
  list: os.developer.tokens.list.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const rows = await deps.db
      .select({ t: oauthTokens, appName: oauthApps.name })
      .from(oauthTokens)
      .leftJoin(oauthApps, eq(oauthApps.id, oauthTokens.appId))
      .where(
        // A token whose access expired but whose refresh token lives is still an authorization.
        and(answeredBy(deps, caller.user.id), liveToken(deps.now())),
      )
      .orderBy(desc(oauthTokens.createdAt))
      .limit(500);
    return rows.map(({ t, appName }) => ({
      id: t.id,
      appId: t.appId,
      appName,
      kind: t.kind,
      scopes: t.scopes as Scope[],
      createdAt: iso(t.createdAt),
      expiresAt: iso(t.expiresAt),
      lastUsedAt: isoOrNull(t.lastUsedAt),
    }));
  }),

  revoke: os.developer.tokens.revoke.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const [row] = await deps.db
      .select({ id: oauthTokens.id })
      .from(oauthTokens)
      .where(and(eq(oauthTokens.id, input.id), answeredBy(deps, caller.user.id), isNull(oauthTokens.revokedAt)))
      .limit(1);
    if (!row) throw notFound("Token not found");
    const revoked = await deps.db.transaction((tx) => revokeTokensInTx(tx, { tokenIds: [row.id] }, deps.now()));
    if (revoked.length === 0) throw notFound("Token not found");
    // Chat, IRC and EventSub close sockets authenticated with this token (best effort; the row is authoritative).
    await publishRevocations(deps, revoked, "token_revoked");
    return { ok: true as const };
  }),
  /** Twitch's GET /oauth2/validate shape, so existing bot libraries work unchanged. */
  validate: os.developer.tokens.validate.handler(async ({ context: { deps, req } }) => {
    const raw = bearerToken(req.headers);
    const resolved = raw ? await resolveBearer(deps, raw) : null;
    const subject = !resolved
      ? null
      : "app" in resolved
        ? { appId: resolved.app.appId, expiresAt: resolved.app.expiresAt, user: null, scopes: [] }
        : resolved.caller.kind === "token"
          ? resolved.caller
          : null;
    if (!subject) throw apiError("UNAUTHORIZED", "Invalid or expired access token");
    let clientId: string | null = null;
    if (subject.appId) {
      const [app] = await deps.db
        .select({ clientId: schema.oauthApps.clientId })
        .from(schema.oauthApps)
        .where(eq(schema.oauthApps.id, subject.appId));
      clientId = app?.clientId ?? null;
    }
    // An app token has no user: `login` and `user_id` are null, as Twitch answers for app tokens.
    return {
      client_id: clientId,
      login: subject.user?.username ?? null,
      user_id: subject.user?.id ?? null,
      scopes: subject.scopes,
      expires_in: Math.max(0, Math.floor((subject.expiresAt.getTime() - deps.now().getTime()) / 1000)),
    };
  }),
};
