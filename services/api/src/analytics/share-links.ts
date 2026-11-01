// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Analytics share links (decision (k)): one broadcast's analytics, without cost, for whoever holds
 * the link until it expires or is revoked. The token is shown once and stored as its SHA-256 only;
 * it is never logged.
 */
import type { AnalyticsShareLink } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { randomTokenSecret, sha256Hex } from "@commonair/tokens";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { analyticsDisplayBypassed } from "../ops/analytics-hooks.ts";
import { broadcastAnalytics, endedBroadcast } from "./queries.ts";

const links = schema.analyticsShareLinks;
type LinkRow = typeof links.$inferSelect;
const DAY_MS = 86_400_000;

const trimSlash = (u: string) => u.replace(/\/+$/, "");
/** The link a recipient opens: the API's public JSON view of the shared broadcast. */
export const shareUrl = (deps: Pick<Deps, "env">, token: string) =>
  `${trimSlash(deps.env.API_PUBLIC_URL)}/api/analytics/shared/${encodeURIComponent(token)}`;

const toLink = (r: LinkRow, url: string | null = null): AnalyticsShareLink => ({
  id: r.id,
  broadcastId: r.broadcastId,
  url,
  expiresAt: r.expiresAt.toISOString(),
  revokedAt: r.revokedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

export async function createShareLink(
  deps: Pick<Deps, "db" | "env" | "now">,
  q: { channelId: string; creatorId: string; broadcastId: string; expiresInDays: number },
): Promise<AnalyticsShareLink> {
  const b = await endedBroadcast(deps, q.channelId, q.broadcastId);
  if (!b) throw notFound("Broadcast not found");
  if (!b.endedAt) throw badRequest("A live broadcast cannot be shared yet");
  const token = randomTokenSecret("", 24);
  const now = deps.now();
  const [row] = await deps.db
    .insert(links)
    .values({
      id: uuidv7(now.getTime()),
      channelId: q.channelId,
      broadcastId: b.id,
      tokenHash: await sha256Hex(token),
      createdById: q.creatorId,
      expiresAt: new Date(now.getTime() + q.expiresInDays * DAY_MS),
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("share link insert returned nothing");
  return toLink(row, shareUrl(deps, token));
}

const encodeCursor = (r: LinkRow) => Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString("base64url");
function decodeCursor(cursor: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const d = new Date(at ?? "");
  if (!id || Number.isNaN(d.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) throw badRequest("Invalid cursor");
  return { at: d, id };
}

export async function listShareLinks(
  deps: Pick<Deps, "db">,
  q: { channelId: string; cursor?: string | undefined; limit: number },
): Promise<{ items: AnalyticsShareLink[]; nextCursor: string | null }> {
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await deps.db
    .select()
    .from(links)
    .where(
      and(
        eq(links.channelId, q.channelId),
        after
          ? or(lt(links.createdAt, after.at), and(eq(links.createdAt, after.at), lt(links.id, after.id)))
          : undefined,
      ),
    )
    .orderBy(desc(links.createdAt), desc(links.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return { items: page.map((r) => toLink(r)), nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null };
}

/** Revoke one of the channel's links; revoking a revoked link again is a no-op. */
export async function revokeShareLink(deps: Pick<Deps, "db" | "now">, q: { channelId: string; id: string }) {
  const [row] = await deps.db
    .select({ id: links.id, revokedAt: links.revokedAt })
    .from(links)
    .where(and(eq(links.id, q.id), eq(links.channelId, q.channelId)));
  if (!row) throw notFound("Share link not found");
  if (!row.revokedAt)
    await deps.db
      .update(links)
      .set({ revokedAt: deps.now() })
      .where(and(eq(links.id, q.id), isNull(links.revokedAt)));
  return { ok: true as const };
}

/**
 * What a share link shows: the broadcast's analytics without cost, under the same display delay
 * and suppression as the owner's view. NOT_FOUND for an unknown, expired or revoked token alike.
 */
export async function sharedAnalytics(deps: Pick<Deps, "db" | "env" | "now" | "valkey">, token: string) {
  const now = deps.now();
  const [link] = await deps.db
    .select({ channelId: links.channelId, broadcastId: links.broadcastId })
    .from(links)
    .where(and(eq(links.tokenHash, await sha256Hex(token)), isNull(links.revokedAt), gt(links.expiresAt, now)))
    .limit(1);
  if (!link) throw notFound("This link has expired or was revoked");
  return broadcastAnalytics(deps, {
    channelId: link.channelId,
    broadcastId: link.broadcastId,
    withCost: false,
    bypassed: await analyticsDisplayBypassed(deps, link.channelId),
  });
}
