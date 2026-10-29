// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer.tokens.*` (E9-oauth): token listing, revocation and Twitch-shaped validation. */
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Scope } from "@commonair/contracts/scopes";
import { schema } from "@commonair/db";
import type { Deps } from "../../deps.ts";
import { bearerToken, resolveToken } from "../../lib/caller.ts";
import { publishUserControl } from "../../lib/control.ts";
import { iso, isoOrNull } from "../../lib/dto.ts";
import { apiError, notFound } from "../../lib/errors.ts";
import { os, requireCaller } from "../../lib/orpc.ts";

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
        and(answeredBy(deps, caller.user.id), isNull(oauthTokens.revokedAt), gt(oauthTokens.expiresAt, deps.now())),
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
      .update(oauthTokens)
      .set({ revokedAt: deps.now() })
      .where(and(eq(oauthTokens.id, input.id), answeredBy(deps, caller.user.id), isNull(oauthTokens.revokedAt)))
      .returning({ userId: oauthTokens.userId, appId: oauthTokens.appId, hash: oauthTokens.accessTokenHash });
    if (!row) throw notFound("Token not found");
    // Chat, IRC and EventSub close sockets authenticated with this token right away.
    await publishUserControl(deps, {
      op: "disconnect",
      userId: row.userId ?? undefined,
      appId: row.appId ?? undefined,
      tokenHash: row.hash,
      reason: "token_revoked",
    });
    return { ok: true as const };
  }),
  /** Twitch's GET /oauth2/validate shape, so existing bot libraries work unchanged. */
  validate: os.developer.tokens.validate.handler(async ({ context: { deps, req } }) => {
    const raw = bearerToken(req.headers);
    const caller = raw ? await resolveToken(deps, raw) : null;
    if (!caller || caller.kind !== "token") throw apiError("UNAUTHORIZED", "Invalid or expired access token");
    let clientId: string | null = null;
    if (caller.appId) {
      const [app] = await deps.db
        .select({ clientId: schema.oauthApps.clientId })
        .from(schema.oauthApps)
        .where(eq(schema.oauthApps.id, caller.appId));
      clientId = app?.clientId ?? null;
    }
    return {
      client_id: clientId,
      login: caller.user.username,
      user_id: caller.user.id,
      scopes: caller.scopes,
      expires_in: Math.max(0, Math.floor((caller.expiresAt.getTime() - deps.now().getTime()) / 1000)),
    };
  }),
};
