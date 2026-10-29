// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer.admin.*` (E9-apps): every app on the instance, suspend and unsuspend (ADR 0027 §4).
 * Suspension revokes every token of the app and its webhook subscriptions, and drops its pending
 * authorization and device codes, in the same transaction as the audit row; the control messages
 * and revocation notices follow after commit, best effort.
 * Unsuspending restores nothing: users re-authorize.
 */
import { and, desc, eq, ilike, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { WEBHOOK_JOBS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import type { Deps } from "../../deps.ts";
import { publishRevocations, revokeTokensInTx, revokeWebhookSubscriptionsInTx } from "../../developer/grants.ts";
import { webhookQueue } from "../../developer/webhook-queue.ts";
import { loadAdminApp, toAdminApps } from "../../developer/apps/queries.ts";
import { audit } from "../../events/audit.ts";
import { decodeCursor, encodeCursor, isKeyCursor } from "../../lib/cursor.ts";
import { conflict, notFound } from "../../lib/errors.ts";
import { os, requireCaller } from "../../lib/orpc.ts";

const { oauthApps, oauthCodes, oauthDeviceCodes, users } = schema;

const APP_NOT_FOUND = "App not found";

// `created_at` keeps microseconds and a cursor carries milliseconds, so the keyset compares and
// orders on the millisecond value; the id breaks ties.
const createdMs = sql<Date>`date_trunc('milliseconds', ${oauthApps.createdAt})`;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** One `revocation` notice per revoked webhook subscription; a failed enqueue is logged, never thrown. */
async function enqueueRevocations(deps: Deps, appId: string, subscriptionIds: readonly string[]): Promise<void> {
  for (const subscriptionId of subscriptionIds) {
    try {
      await webhookQueue(deps).enqueue(WEBHOOK_JOBS.revocation, { subscriptionId }, `revocation-${subscriptionId}`);
    } catch (err) {
      deps.logger.warn("revocation enqueue failed", { appId, subscriptionId, err });
    }
  }
}

async function adminView(deps: Deps, id: string) {
  const app = await loadAdminApp(deps, id);
  // The row was locked and updated in the transaction just committed; only a concurrent delete
  // by its owner gets here.
  if (!app) throw notFound(APP_NOT_FOUND);
  return app;
}

export const admin = {
  list: os.developer.admin.list.handler(async ({ context, input }) => {
    const { deps } = context;
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const q = input.q?.trim();
    const where: (SQL | undefined)[] = [
      q ? or(ilike(oauthApps.name, `%${likeEscape(q)}%`), eq(oauthApps.clientId, q)) : undefined,
      input.suspended === undefined
        ? undefined
        : input.suspended
          ? isNotNull(oauthApps.suspendedAt)
          : isNull(oauthApps.suspendedAt),
      cur
        ? or(
            sql`${createdMs} < ${cur.t}::timestamptz`,
            and(sql`${createdMs} = ${cur.t}::timestamptz`, lt(oauthApps.id, cur.id)),
          )
        : undefined,
    ];
    const rows = await deps.db
      .select({ app: oauthApps, owner: { id: users.id, username: users.username } })
      .from(oauthApps)
      .innerJoin(users, eq(users.id, oauthApps.ownerId))
      .where(and(...where))
      .orderBy(desc(createdMs), desc(oauthApps.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: await toAdminApps(deps, page),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ t: last.app.createdAt.toISOString(), id: last.app.id })
          : null,
    };
  }),

  suspend: os.developer.admin.suspend.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const now = deps.now();
    const { tokens, subscriptionIds } = await deps.db.transaction(async (tx) => {
      const [app] = await tx.select().from(oauthApps).where(eq(oauthApps.id, input.id)).for("update");
      if (!app) throw notFound(APP_NOT_FOUND);
      if (app.suspendedAt) throw conflict("This app is already suspended");
      await tx
        .update(oauthApps)
        .set({ suspendedAt: now, suspendedReason: input.reason, suspendedById: caller.user.id })
        .where(eq(oauthApps.id, app.id));
      const revokedTokens = await revokeTokensInTx(tx, { appId: app.id }, now);
      const revokedSubs = await revokeWebhookSubscriptionsInTx(tx, { appId: app.id });
      // Pending codes would otherwise mint fresh tokens if the app is unsuspended inside their
      // lifetime; unsuspending must restore nothing (ADR 0027 §4).
      await tx.delete(oauthCodes).where(eq(oauthCodes.appId, app.id));
      await tx.delete(oauthDeviceCodes).where(eq(oauthDeviceCodes.appId, app.id));
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: "developer.app.suspend",
        subjectType: "oauth_app",
        subjectId: app.id,
        details: { reason: input.reason, tokens: revokedTokens.length, subscriptions: revokedSubs.length },
      });
      return { tokens: revokedTokens, subscriptionIds: revokedSubs };
    });
    deps.logger.info("oauth app suspended", {
      appId: input.id,
      reason: input.reason,
      tokens: tokens.length,
      subscriptions: subscriptionIds.length,
    });
    await publishRevocations(deps, tokens, "app_suspended", { appId: input.id });
    await enqueueRevocations(deps, input.id, subscriptionIds);
    return adminView(deps, input.id);
  }),

  /** Lifts the suspension only: revoked tokens and subscriptions stay revoked (ADR 0027 §4). */
  unsuspend: os.developer.admin.unsuspend.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    await deps.db.transaction(async (tx) => {
      const [app] = await tx.select().from(oauthApps).where(eq(oauthApps.id, input.id)).for("update");
      if (!app) throw notFound(APP_NOT_FOUND);
      if (!app.suspendedAt) throw conflict("This app is not suspended");
      await tx
        .update(oauthApps)
        .set({ suspendedAt: null, suspendedReason: null, suspendedById: null })
        .where(eq(oauthApps.id, app.id));
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: "developer.app.unsuspend",
        subjectType: "oauth_app",
        subjectId: app.id,
        details: { previousReason: app.suspendedReason },
      });
    });
    deps.logger.info("oauth app unsuspended", { appId: input.id });
    return adminView(deps, input.id);
  }),
};
