// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `admin.egress`: bytes delivered by source (origin, relay, P2P, CDN) over a range, from the
 * worker's per-minute `egress_samples`. Egress by source is what the hosting provider bills and
 * what P2P/relays are meant to move, so admins see it per broadcast as well.
 */
import { sql } from "drizzle-orm";
import { DELIVERY_SOURCES } from "@commonair/contracts/enums";
import type { Executor } from "@commonair/db";
import { iso } from "../lib/dto.ts";
import { badRequest } from "../lib/errors.ts";

export type DeliverySource = (typeof DELIVERY_SOURCES)[number];
export type SourceBytes = Record<DeliverySource, number>;

/** The longest range one report covers (a billing month plus a day). */
export const EGRESS_MAX_RANGE_MS = 31 * 86_400_000;
/**
 * Broadcasts listed per report, by total bytes. The totals always cover every broadcast in the
 * range; only the per-broadcast table is capped, so a busy month stays one bounded response.
 */
export const EGRESS_BROADCAST_CAP = 200;

/** `from < to`, at most `EGRESS_MAX_RANGE_MS` apart; otherwise BAD_REQUEST. */
export function egressRange(from: string, to: string): { from: Date; to: Date } {
  const f = new Date(from);
  const t = new Date(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw badRequest("Invalid range");
  if (f.getTime() >= t.getTime()) throw badRequest("The range must end after it starts");
  if (t.getTime() - f.getTime() > EGRESS_MAX_RANGE_MS) throw badRequest("The range may cover at most 31 days");
  return { from: f, to: t };
}

export function zeroBytes(): SourceBytes {
  return Object.fromEntries(DELIVERY_SOURCES.map((s) => [s, 0])) as SourceBytes;
}

const isSource = (v: unknown): v is DeliverySource =>
  typeof v === "string" && (DELIVERY_SOURCES as readonly string[]).includes(v);

/** A `::bigint` sum (text or number from the driver) as a JS number; refuses anything unsafe. */
export function safeBytes(v: unknown): number {
  // A sum over no rows is SQL null: nothing delivered.
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" || typeof v === "bigint"
        ? Number(v)
        : v === null || v === undefined
          ? 0
          : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("egress byte sum is not a safe non-negative integer");
  return n;
}

/** Sum rows into one record with every source present (0 when it delivered nothing). */
export function fillSources(rows: readonly { source: unknown; bytes: unknown }[]): SourceBytes {
  const out = zeroBytes();
  for (const r of rows) {
    if (!isSource(r.source)) continue;
    const next = out[r.source] + safeBytes(r.bytes);
    if (!Number.isSafeInteger(next)) throw new Error("egress byte sum is not a safe integer");
    out[r.source] = next;
  }
  return out;
}

/** postgres.js cannot bind Date objects inside raw `sql`: ISO text with a cast. */
const tsz = (d: Date) => sql`${d.toISOString()}::timestamptz`;
type Row = Record<string, unknown>;

export interface EgressReportDto {
  from: string;
  to: string;
  totals: SourceBytes;
  byBroadcast: { broadcastId: string; channelSlug: string; bytes: SourceBytes }[];
}

export async function egressReport(db: Executor, range: { from: Date; to: Date }): Promise<EgressReportDto> {
  const inRange = sql`e.bucket_start >= ${tsz(range.from)} and e.bucket_start < ${tsz(range.to)}`;
  const totals = (await db.execute(sql`
    select e.source::text as source, sum(e.bytes)::bigint::text as bytes
      from egress_samples e
     where ${inRange}
     group by e.source`)) as unknown as Row[];
  const perSource = (await db.execute(sql`
    with top as (
      select e.broadcast_id, sum(e.bytes) as total
        from egress_samples e
       where ${inRange}
       group by e.broadcast_id
       order by total desc, e.broadcast_id
       limit ${EGRESS_BROADCAST_CAP}
    )
    select t.broadcast_id::text as broadcast_id, c.slug, e.source::text as source,
           sum(e.bytes)::bigint::text as bytes
      from top t
      join broadcasts b on b.id = t.broadcast_id
      join channels c on c.id = b.channel_id
      join egress_samples e on e.broadcast_id = t.broadcast_id and ${inRange}
     group by t.broadcast_id, t.total, c.slug, e.source
     order by t.total desc, t.broadcast_id`)) as unknown as Row[];
  return {
    from: iso(range.from),
    to: iso(range.to),
    totals: fillSources(totals.map((r) => ({ source: r.source, bytes: r.bytes }))),
    byBroadcast: groupByBroadcast(perSource),
  };
}

/** Rows ordered by broadcast (total descending) → one entry per broadcast, order kept. */
export function groupByBroadcast(rows: readonly Row[]): EgressReportDto["byBroadcast"] {
  const out: EgressReportDto["byBroadcast"] = [];
  const index = new Map<string, number>();
  for (const r of rows) {
    const id = String(r.broadcast_id);
    let i = index.get(id);
    if (i === undefined) {
      i = out.length;
      index.set(id, i);
      out.push({ broadcastId: id, channelSlug: String(r.slug), bytes: zeroBytes() });
    }
    const entry = out[i];
    if (entry && isSource(r.source)) entry.bytes[r.source] += safeBytes(r.bytes);
  }
  return out;
}
