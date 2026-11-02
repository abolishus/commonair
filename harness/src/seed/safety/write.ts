// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-safety's only direct insert: `hash_match_results`, a plain table no service writes yet. Each
 * row mirrors a T0 hash-list match the stack itself made during the run (the case, its list and the
 * flag's provider and distance), so the record matches what really happened. Ids, enums and numbers
 * only: no personal data, no hash, no image bytes.
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
