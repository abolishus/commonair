// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity.flags` and `integrity.decide`: the admin review of what the integrity jobs flagged
 * (`packages/integrity/src/jobs.ts`). An `allowed` decision on a session or account flag is an
 * allowance the scorer honours from `decided_at` on (`packages/integrity/src/allowance.ts`).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { INTEGRITY_DECISIONS, INTEGRITY_SUBJECTS } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso } from "../lib/dto.ts";
import { conflict, notFound } from "../lib/errors.ts";

type FlagRow = typeof schema.integrityFlags.$inferSelect;
type Decision = (typeof INTEGRITY_DECISIONS)[number];

/**
 * `details` keys that may leave the API, from what the signals and jobs write (ids, enums and
 * measured numbers only). Everything else is dropped, so a future signal that records a raw IP,
 * user agent, fingerprint or device/IP hash never reaches the admin page by accident.
 *
 * - network (`signals/network.ts`): `network` (operator list label), `asn`
 * - concurrency: `rank`, `concurrent`, `max`
 * - headless: `flags` (check codes)
 * - heartbeat / fetch: `checks` plus their measures
 * - session exclusion (`jobs.ts`): `sessionScore`, `threshold`
 * - relay receipts and standing: receipt/relay ids, byte counts, ratios, reasons
 * - follow bursts: per-follow facts and the channel's `bursts` (`minuteStart`, `follows`, `excluded`)
 */
export const DETAIL_KEYS: ReadonlySet<string> = new Set([
  // network
  "network",
  "asn",
  // concurrency
  "rank",
  "concurrent",
  "max",
  // headless, heartbeat, fetch
  "flags",
  "checks",
  "beats",
  "playedToWall",
  "intervalStdevMs",
  "segments",
  "playlists",
  "expectedSegments",
  "segmentRatio",
  "relayObjects",
  "claimedSeconds",
  "p2pEvidenced",
  "linkedNetworks",
  "linkedWithinCap",
  "sameNetworkPeers",
  "httpShare",
  // session exclusion
  "sessionScore",
  "threshold",
  // relays
  "receiptId",
  "relayId",
  "bytesReported",
  "bytesIssued",
  "bytesVerified",
  "tolerance",
  "gapMinutes",
  "reason",
  "overReportRatio",
  "suspend",
  "overReportingPeriods",
  "periodsConsidered",
  "worstRatio",
  "since",
  // follows
  "followedAt",
  "accountAgeDays",
  "priorViewingSeconds",
  "perMinute",
  "bursts",
  "minuteStart",
  "follows",
  "excluded",
]);

/** An IPv4 address anywhere in the string (also CIDRs and `ip:port`). */
const IPV4 = /(?:^|[^\d.])\d{1,3}(?:\.\d{1,3}){3}(?:$|[^\d.])/;
/** A bare IPv6 address (hex and colons, optionally with an embedded IPv4 or a prefix length). */
const IPV6 = /^\[?[0-9a-f:]*:[0-9a-f:]*:[0-9a-f:.]*\]?(?:\/\d{1,3})?$/i;
const MAX_STRING = 200;
const MAX_DEPTH = 3;

/** A string that is safe to show: short, and not an address even under an allowed key. */
export function safeString(v: string): boolean {
  return v.length <= MAX_STRING && !IPV4.test(v) && !IPV6.test(v);
}

function clean(v: unknown, depth: number): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return safeString(v) ? v : undefined;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === "object") return sanitizeDetails(v as Record<string, unknown>, depth + 1);
  return undefined;
}

/** `details` with only `DETAIL_KEYS` (recursively) and no address-like or long strings. */
export function sanitizeDetails(details: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (!DETAIL_KEYS.has(k)) continue;
    const c = clean(v, depth);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

export function toFlag(r: FlagRow) {
  return {
    id: r.id,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    signal: r.signal,
    score: r.score,
    details: sanitizeDetails(r.details ?? {}),
    decision: r.decision,
    createdAt: iso(r.createdAt),
  };
}

export interface FlagsInput {
  cursor?: string | undefined;
  limit: number;
  subjectType?: (typeof INTEGRITY_SUBJECTS)[number] | undefined;
  decision?: Decision | undefined;
  channel?: string | undefined;
}

/** Newest first, keyset on (`created_at`, `id`). An unknown channel slug matches nothing. */
export async function listFlags(deps: Deps, input: FlagsInput) {
  const f = schema.integrityFlags;
  const cur = decodeCursor(input.cursor, isKeyCursor);
  let channelId: string | undefined;
  if (input.channel !== undefined) {
    const [c] = await deps.db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.slug, input.channel));
    if (!c) return { items: [], nextCursor: null };
    channelId = c.id;
  }
  const rows = await deps.db
    .select()
    .from(f)
    .where(
      and(
        input.subjectType ? eq(f.subjectType, input.subjectType) : undefined,
        input.decision ? eq(f.decision, input.decision) : undefined,
        channelId ? eq(f.channelId, channelId) : undefined,
        cur ? sql`(${f.createdAt}, ${f.id}) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(f.createdAt), desc(f.id))
    .limit(input.limit + 1);
  return pageOf(rows, input.limit, toFlag, (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }));
}

/**
 * Decide a flag in one transaction: lock it, compare-and-set from the decision read (the same
 * decision again is a CONFLICT), audit with the admin's reason in the `reason` column.
 */
export async function decideFlag(
  deps: Deps,
  actorId: string,
  input: { id: string; decision: "excluded" | "allowed"; reason: string },
) {
  const f = schema.integrityFlags;
  const now = deps.now();
  const row = await deps.db.transaction(async (tx) => {
    const [current] = await tx.select().from(f).where(eq(f.id, input.id)).for("update");
    if (!current) throw notFound("Flag not found");
    if (current.decision === input.decision) throw conflict(`The flag is already ${input.decision}`);
    const [updated] = await tx
      .update(f)
      .set({ decision: input.decision, decidedById: actorId, decidedAt: now })
      .where(and(eq(f.id, current.id), eq(f.decision, current.decision)))
      .returning();
    if (!updated) throw conflict("The flag changed while it was being decided");
    await audit(tx, {
      actorType: "admin",
      actorId,
      action: "integrity.flag.decide",
      subjectType: "integrity_flag",
      subjectId: current.id,
      channelId: current.channelId,
      reason: input.reason,
      details: {
        flagId: current.id,
        from: current.decision,
        to: input.decision,
        signal: current.signal,
        subjectType: current.subjectType,
      },
    });
    return updated;
  });
  return toFlag(row);
}
