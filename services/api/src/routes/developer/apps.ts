// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer.apps.*` (E9-apps): register, update, rotate and delete OAuth apps (ADR 0027 §1).
 * Session only (the contract gives no token scope), so bots, which have no session, never get here.
 * Someone else's app answers `NOT_FOUND`, never `FORBIDDEN`, so app ids do not leak.
 */
import { count, desc, eq, sql } from "drizzle-orm";
import { OAUTH_LIMITS } from "@commonair/contracts/oauth";
import { schema } from "@commonair/db";
import { publishRevocations, revokeTokensInTx } from "../../developer/grants.ts";
import { mintClientId, mintClientSecret } from "../../developer/apps/credentials.ts";
import { toOAuthApp, type OAuthAppRow } from "../../developer/apps/dto.ts";
import { ownedApp } from "../../developer/apps/queries.ts";
import { badRequest, notFound, precondition } from "../../lib/errors.ts";
import { os, requireCaller } from "../../lib/orpc.ts";

const { oauthApps } = schema;

const APP_NOT_FOUND = "App not found";

/** Trimmed, and still non-empty (the contract's `min(1)` counts spaces). */
function cleanName(name: string): string {
  const n = name.trim();
  if (!n) throw badRequest("The app name cannot be blank");
  return n;
}

/** Order kept, duplicates dropped: the list is matched exactly at authorize time. */
const uniqueUris = (uris: readonly string[]) => [...new Set(uris)];

function assertChangeable(app: OAuthAppRow): void {
  if (app.suspendedAt) throw precondition("app_suspended", "This app is suspended");
}

export const apps = {
  list: os.developer.apps.list.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const rows = await deps.db
      .select()
      .from(oauthApps)
      .where(eq(oauthApps.ownerId, caller.user.id))
      // No limit: `create` keeps an owner at OAUTH_LIMITS.appsPerUser.
      .orderBy(desc(oauthApps.createdAt), desc(oauthApps.id));
    return rows.map(toOAuthApp);
  }),

  create: os.developer.apps.create.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const name = cleanName(input.name);
    const secret = input.confidential ? await mintClientSecret() : null;
    const row = await deps.db.transaction(async (tx) => {
      // Serializes one owner's creates, so two at once cannot both pass the limit.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`oauth_apps:${caller.user.id}`}, 0))`);
      const [owned] = await tx.select({ n: count() }).from(oauthApps).where(eq(oauthApps.ownerId, caller.user.id));
      if ((owned?.n ?? 0) >= OAUTH_LIMITS.appsPerUser)
        throw precondition("app_limit", `You can register at most ${OAUTH_LIMITS.appsPerUser} apps`);
      const [inserted] = await tx
        .insert(oauthApps)
        .values({
          ownerId: caller.user.id,
          name,
          description: input.description.trim(),
          clientId: mintClientId(),
          clientSecretHash: secret?.hash ?? null,
          redirectUris: uniqueUris(input.redirectUris),
          confidential: input.confidential,
        })
        .returning();
      // The insert either returns the row or throws.
      return inserted as OAuthAppRow;
    });
    deps.logger.info("oauth app created", { appId: row.id, confidential: row.confidential });
    return {
      app: toOAuthApp(row),
      secret: secret ? { clientId: row.clientId, clientSecret: secret.secret } : null,
    };
  }),

  update: os.developer.apps.update.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const row = await deps.db.transaction(async (tx) => {
      const app = await ownedApp(tx, input.id, caller.user.id, true);
      if (!app) throw notFound(APP_NOT_FOUND);
      assertChangeable(app);
      const patch: Partial<typeof oauthApps.$inferInsert> = {};
      if (input.name !== undefined) patch.name = cleanName(input.name);
      if (input.description !== undefined) patch.description = input.description.trim();
      // Tokens survive a redirect change: a code is checked against the URI it was issued for.
      if (input.redirectUris !== undefined) patch.redirectUris = uniqueUris(input.redirectUris);
      if (Object.keys(patch).length === 0) return app;
      const [updated] = await tx.update(oauthApps).set(patch).where(eq(oauthApps.id, app.id)).returning();
      return updated ?? app;
    });
    return toOAuthApp(row);
  }),

  /** The old secret stops working at once (no overlap window). Tokens are not revoked. */
  rotateSecret: os.developer.apps.rotateSecret.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const secret = await mintClientSecret();
    const clientId = await deps.db.transaction(async (tx) => {
      const app = await ownedApp(tx, input.id, caller.user.id, true);
      if (!app) throw notFound(APP_NOT_FOUND);
      if (!app.confidential) throw precondition("public_client", "A public client has no secret");
      assertChangeable(app);
      await tx
        .update(oauthApps)
        .set({ clientSecretHash: secret.hash, secretRotatedAt: deps.now() })
        .where(eq(oauthApps.id, app.id));
      return app.clientId;
    });
    deps.logger.info("oauth app secret rotated", { appId: input.id });
    return { clientId, clientSecret: secret.secret };
  }),

  /**
   * Deletes the app; the foreign keys take its codes, tokens, device codes, subscriptions and their
   * deliveries with it. Sockets close through the app-wide `app_removed`. No revocation webhook can
   * be sent: the subscription rows are gone with the app. A suspended app cannot be removed.
   */
  remove: os.developer.apps.remove.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const revoked = await deps.db.transaction(async (tx) => {
      const app = await ownedApp(tx, input.id, caller.user.id, true);
      if (!app) throw notFound(APP_NOT_FOUND);
      // A suspended app stays on record for admins; the owner cannot wipe it and re-register.
      assertChangeable(app);
      // Revoked first only to learn the token hashes the disconnect messages need.
      const tokens = await revokeTokensInTx(tx, { appId: app.id }, deps.now());
      await tx.delete(oauthApps).where(eq(oauthApps.id, app.id));
      return tokens;
    });
    deps.logger.info("oauth app removed", { appId: input.id, tokens: revoked.length });
    await publishRevocations(deps, revoked, "app_removed", { appId: input.id });
    return { ok: true as const };
  }),
};
