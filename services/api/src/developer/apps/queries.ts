// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Reads behind `developer.apps.*` and `developer.admin.*`: owned apps, admin counts, owners. */
import { and, countDistinct, count, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import type { Deps } from "../../deps.ts";
import { toAdminOAuthApp, type AdminOAuthApp, type AppCounts, type OAuthAppRow } from "./dto.ts";

const { oauthApps, oauthTokens, eventSubscriptions, users } = schema;

/**
 * The app when `ownerId` owns it, else null. Callers answer `NOT_FOUND` for both "no such app" and
 * "someone else's", so app ids do not leak. `lock` takes the row lock for a write transaction.
 */
export async function ownedApp(db: Executor, id: string, ownerId: string, lock = false): Promise<OAuthAppRow | null> {
  const q = db
    .select()
    .from(oauthApps)
    .where(and(eq(oauthApps.id, id), eq(oauthApps.ownerId, ownerId)));
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

/**
 * Per app: distinct users with a live grant (an unrevoked user token whose access token, or
 * refresh token, is unexpired; app-only tokens are no grant) and enabled webhook subscriptions.
 * Two grouped queries, whatever the number of apps.
 */
export async function appCounts(db: Executor, appIds: readonly string[], now: Date): Promise<Map<string, AppCounts>> {
  const out = new Map<string, AppCounts>(appIds.map((id) => [id, { grants: 0, subscriptions: 0 }]));
  if (appIds.length === 0) return out;
  const ids = [...appIds];
  const t = oauthTokens;
  const [grants, subs] = await Promise.all([
    db
      .select({ appId: t.appId, n: countDistinct(t.userId) })
      .from(t)
      .where(
        and(
          inArray(t.appId, ids),
          isNotNull(t.userId),
          isNull(t.revokedAt),
          or(gt(t.expiresAt, now), and(isNotNull(t.refreshTokenHash), gt(t.refreshExpiresAt, now))),
        ),
      )
      .groupBy(t.appId),
    db
      .select({ appId: eventSubscriptions.appId, n: count() })
      .from(eventSubscriptions)
      .where(
        and(
          inArray(eventSubscriptions.appId, ids),
          eq(eventSubscriptions.transport, "webhook"),
          eq(eventSubscriptions.status, "enabled"),
        ),
      )
      .groupBy(eventSubscriptions.appId),
  ]);
  for (const g of grants) {
    const c = g.appId ? out.get(g.appId) : undefined;
    if (c) c.grants = Number(g.n);
  }
  for (const s of subs) {
    const c = s.appId ? out.get(s.appId) : undefined;
    if (c) c.subscriptions = Number(s.n);
  }
  return out;
}

/** Rows (already joined with their owners) → `AdminOAuthApp`s, in order, with their counts. */
export async function toAdminApps(
  deps: Deps,
  rows: readonly { app: OAuthAppRow; owner: { id: string; username: string } }[],
): Promise<AdminOAuthApp[]> {
  const counts = await appCounts(
    deps.db,
    rows.map((r) => r.app.id),
    deps.now(),
  );
  return rows.map((r) => toAdminOAuthApp(r.app, r.owner, counts.get(r.app.id) ?? { grants: 0, subscriptions: 0 }));
}

/** One app as an admin sees it (after a suspension or unsuspension commits). */
export async function loadAdminApp(deps: Deps, id: string): Promise<AdminOAuthApp | null> {
  const rows = await deps.db
    .select({ app: oauthApps, owner: { id: users.id, username: users.username } })
    .from(oauthApps)
    .innerJoin(users, eq(users.id, oauthApps.ownerId))
    .where(eq(oauthApps.id, id));
  const [one] = await toAdminApps(deps, rows);
  return one ?? null;
}
