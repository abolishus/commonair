// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The actor's collections (ADR 0030 decisions 2 and 9).
 *
 * - `outbox`: the public `Create` activities, newest first and paged, one per `federation_objects`
 *   row not yet deleted. Each links its object by its stable id; the object itself is what the
 *   worker delivered.
 * - `followers`: a `totalItems` count and no items, ever. The list is other people's accounts.
 */
import { AS2_CONTEXT, AS2_PUBLIC } from "@commonair/federation";
import { schema } from "@commonair/db";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { createActivityUrl, followersUrl, objectUrl, outboxUrl } from "./ids.ts";

const { federationFollowers, federationObjects } = schema;

export const OUTBOX_PAGE_SIZE = 20;

// The cursor carries milliseconds; published_at has microseconds. Comparing at millisecond
// precision keeps rows that share a millisecond from being skipped between pages.
const publishedMs = sql<Date>`date_trunc('milliseconds', ${federationObjects.publishedAt})`;

export async function followersCollection(deps: Pick<Deps, "db">, actor: string, channelId: string) {
  const [row] = await deps.db
    .select({ n: count() })
    .from(federationFollowers)
    .where(eq(federationFollowers.channelId, channelId));
  return {
    "@context": AS2_CONTEXT,
    id: followersUrl(actor),
    type: "OrderedCollection",
    totalItems: row?.n ?? 0,
  };
}

interface OutboxCursor {
  t: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<publishedAt ms>_<id>`: a keyset position, opaque to clients. Null when malformed. */
export function parseOutboxCursor(raw: string | null): OutboxCursor | null {
  if (!raw || raw.length > 64) return null;
  const m = /^(\d{1,15})_(.+)$/.exec(raw);
  if (!m?.[2] || !UUID.test(m[2])) return null;
  return { t: new Date(Number(m[1])), id: m[2] };
}
export const outboxCursor = (c: { publishedAt: Date; id: string }) => `${c.publishedAt.getTime()}_${c.id}`;

/**
 * The outbox: without `page`, the collection with its count and a `first` link; with `page=true`
 * (optionally `cursor`), one `OrderedCollectionPage`.
 */
export async function outboxCollection(
  deps: Pick<Deps, "db" | "site">,
  actor: string,
  channelId: string,
  query: URLSearchParams,
) {
  const id = outboxUrl(actor);
  const live = and(eq(federationObjects.channelId, channelId), isNull(federationObjects.deletedAt));
  if (query.get("page") !== "true") {
    const [row] = await deps.db.select({ n: count() }).from(federationObjects).where(live);
    return {
      "@context": AS2_CONTEXT,
      id,
      type: "OrderedCollection",
      totalItems: row?.n ?? 0,
      first: `${id}?page=true`,
    };
  }
  const cursor = parseOutboxCursor(query.get("cursor"));
  const rows = await deps.db
    .select()
    .from(federationObjects)
    .where(
      and(
        live,
        cursor
          ? sql`(${publishedMs}, ${federationObjects.id}) < (${cursor.t.toISOString()}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(publishedMs), desc(federationObjects.id))
    .limit(OUTBOX_PAGE_SIZE + 1);
  const items = rows.slice(0, OUTBOX_PAGE_SIZE);
  const last = items.at(-1);
  const pageId = cursor ? `${id}?page=true&cursor=${encodeURIComponent(query.get("cursor") ?? "")}` : `${id}?page=true`;
  return {
    "@context": AS2_CONTEXT,
    id: pageId,
    type: "OrderedCollectionPage",
    partOf: id,
    ...(rows.length > OUTBOX_PAGE_SIZE && last ? { next: `${id}?page=true&cursor=${outboxCursor(last)}` } : {}),
    orderedItems: items.map((o) => ({
      id: createActivityUrl(deps.site, o.id),
      type: "Create",
      actor,
      published: o.publishedAt.toISOString(),
      to: [AS2_PUBLIC],
      cc: [followersUrl(actor)],
      object: objectUrl(deps.site, o.id),
    })),
  };
}
