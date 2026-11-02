// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-safety's direct inserts, both into plain tables (no trigger), ids, enums and numbers only:
 * no personal data, no hash, no image bytes.
 *
 * - `hash_match_results`, which no service writes yet. Each row mirrors a T0 hash-list match the
 *   stack itself made during the run (the case, its list and the flag's provider and distance), so
 *   the record matches what really happened.
 * - `integrity_flags` awaiting review (`pending_review`). The worker raises one only for a relay
 *   receipt it cannot check because the issuance record has gaps (`relay_issuance_unknown`,
 *   packages/integrity/src/jobs.ts), which a seed cannot provoke on purpose; every other signal is
 *   decided on the spot. `/admin/integrity` opens on the pending queue, so one such flag per seeded
 *   relay, in the worker's own shape, gives staff something to decide.
 */
import { schema, uuidv7, type DbHandle } from "@commonair/db";

const CHUNK = 1_000;

export interface HashMatchSpec {
  /** The T0 case's subject (`upload`, `broadcast`, `vod` or `clip`) and id. */
  subjectType: string;
  subjectId: string;
  provider: string;
  matched: boolean;
  caseId: string;
  listCategory: "csam" | "ncii" | null;
  distance: number | null;
  checkedAt: Date;
}

/** The row a spec becomes. Pure; the details carry ids and enums only. */
export function hashMatchRow(s: HashMatchSpec) {
  return {
    id: uuidv7(s.checkedAt.getTime()),
    subjectType: s.subjectType,
    subjectId: s.subjectId,
    provider: s.provider,
    matched: s.matched,
    details: { caseId: s.caseId, listCategory: s.listCategory, distance: s.distance },
    checkedAt: s.checkedAt,
  };
}

/** Insert in chunks of at most 1 000 rows, checking `signal` between chunks; returns the rows written. */
export async function writeHashMatches(
  h: DbHandle,
  specs: readonly HashMatchSpec[],
  signal?: AbortSignal,
): Promise<number> {
  let n = 0;
  for (let i = 0; i < specs.length; i += CHUNK) {
    signal?.throwIfAborted();
    const rows = specs.slice(i, i + CHUNK).map(hashMatchRow);
    await h.db.insert(schema.hashMatchResults).values(rows);
    n += rows.length;
  }
  return n;
}

/** The worker's default `integrity.thresholds.relayOverReportTolerance` (packages/db/src/seed.ts). */
export const DEFAULT_RELAY_TOLERANCE = 0.1;

export interface PendingRelayFlagSpec {
  relayId: string;
  /** The relay's newest receipt, the one the flag is about (null if it sent none). */
  receiptId: string | null;
  bytesReported: number;
  tolerance: number;
  at: Date;
}

/** The flag a spec becomes: the worker's `relay_issuance_unknown` row, left for review. Pure. */
export function pendingRelayFlagRow(s: PendingRelayFlagSpec) {
  return {
    id: uuidv7(s.at.getTime()),
    subjectType: "relay" as const,
    subjectId: s.relayId,
    channelId: null,
    signal: "relay_issuance_unknown",
    score: 0,
    details: {
      receiptId: s.receiptId,
      bytesReported: s.bytesReported,
      bytesIssued: null,
      tolerance: s.tolerance,
      gapMinutes: 1,
      bytesVerified: 0,
    },
    decision: "pending_review" as const,
    createdAt: s.at,
  };
}

/**
 * One pending `relay_issuance_unknown` flag per relay node (seed-media registers them), about its
 * newest receipt; returns the flags written.
 */
export async function writePendingRelayFlags(h: DbHandle, at: Date, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const relays = await h.sql<{ relay_id: string; receipt_id: string | null; bytes_reported: number | null }[]>`
    select n.id::text as relay_id, r.id::text as receipt_id, r.bytes_reported::float8 as bytes_reported
      from relay_nodes n
      left join lateral (
        select id, bytes_reported from relay_receipts where relay_id = n.id order by period_end desc, id desc limit 1
      ) r on true
     order by n.created_at, n.id`;
  if (relays.length === 0) return 0;
  const [setting] = await h.sql<{ tolerance: number | null }[]>`
    select (value ->> 'relayOverReportTolerance')::float8 as tolerance
      from governance_settings where key = 'integrity.thresholds'`;
  const tolerance = setting?.tolerance ?? DEFAULT_RELAY_TOLERANCE;
  const rows = relays.map((r) =>
    pendingRelayFlagRow({
      relayId: r.relay_id,
      receiptId: r.receipt_id,
      bytesReported: Number(r.bytes_reported ?? 0),
      tolerance,
      at,
    }),
  );
  await h.db.insert(schema.integrityFlags).values(rows);
  return rows.length;
}
