// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Appeal stickiness. A decision in a viewer's favour must survive rescoring, without
 * becoming a whitelist for whatever the account does next.
 *
 * Allowances (the decision time is T):
 *
 *   - an `integrity_flags` row with `decision = 'allowed'` (admin "clear flag"), on the
 *     session or on the account (`subject_type = 'user'`): covers that flag's signal; T is
 *     `decided_at`.
 *   - an `appeals` row with `kind = 'integrity'`, `status = 'overturned'` whose subject is the
 *     session (`subject_type = 'session'`) or one of its flags (`'integrity_flag'`): covers
 *     every signal flagged on the session at or before T (`resolved_at`).
 *   - the same for the account (`subject_type = 'user'`, or a flag on the account): covers
 *     every signal flagged on any of the account's sessions, or on the account, at or before T.
 *
 * Rule: an allowance only applies to sessions that **started at or before T**; sessions
 * started later are scored normally (no covered signals, no lifted `media_unconfirmed` hold,
 * no lifted concurrency). For the sessions it applies to, covered signals never count again.
 * New evidence after T still does: a signal that had not fired on the subject before T
 * counts normally, and the heartbeat checks (`heartbeat_inconsistent`) only look at beats
 * received after T. An excluded session with an allowance is rescored, so an overturn
 * restores it even when the resolver did not reset the verdict.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import type { Allowance } from "./types.ts";

export interface AllowanceRow {
  at: Date;
  codes: readonly string[];
}

/** Combine several decisions: the union of what they cover, as of the latest one. */
export function mergeAllowances(rows: readonly AllowanceRow[]): Allowance | null {
  if (rows.length === 0) return null;
  const codes = new Set<string>();
  let since = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    for (const c of r.codes) codes.add(c);
    since = Math.max(since, r.at.getTime());
  }
  return { since, codes: [...codes].sort() };
}

/**
 * SQL predicate: the session aliased `p` has at least one allowance that applies to it
 * (decided at or after the session started). Lets excluded sessions with an allowance
 * back into the scoring candidates. Uses `appeals_subject_idx`.
 */
export const HAS_ALLOWANCE = sql`(
  exists (select 1 from integrity_flags af
           where af.decision = 'allowed' and af.decided_at is not null and af.decided_at >= p.started_at
             and ((af.subject_type = 'session' and af.subject_id = p.id)
               or (af.subject_type = 'user' and af.subject_id = p.user_id)))
  or exists (select 1 from appeals ap
              where ap.kind = 'integrity' and ap.status = 'overturned' and ap.resolved_at is not null
                and ap.resolved_at >= p.started_at
                and ((ap.subject_type = 'session' and ap.subject_id = p.id)
                  or (ap.subject_type = 'user' and ap.subject_id = p.user_id)
                  or (ap.subject_type = 'integrity_flag' and ap.subject_id in (
                        select f.id from integrity_flags f
                         where (f.subject_type = 'session' and f.subject_id = p.id)
                            or (f.subject_type = 'user' and f.subject_id = p.user_id)))))
)`;

/** Allowances that apply to the given sessions, keyed by session id. */
export async function loadAllowances(
  db: Executor,
  sessions: readonly { id: string; userId: string | null; startedAt: Date }[],
): Promise<Map<string, Allowance>> {
  const out = new Map<string, Allowance>();
  if (sessions.length === 0) return out;
  const input = sessions.map((s) => ({ sid: s.id, uid: s.userId, started: s.startedAt.toISOString() }));
  const result = (await db.execute(sql`
    with c as (
      select * from jsonb_to_recordset(${JSON.stringify(input)}::jsonb) as v(sid uuid, uid uuid, started timestamptz)
    )
    select c.sid, x.at, x.codes
      from c
     cross join lateral (
       select f.decided_at as at, array[f.signal] as codes
         from integrity_flags f
        where f.decision = 'allowed' and f.decided_at is not null
          and ((f.subject_type = 'session' and f.subject_id = c.sid)
            or (f.subject_type = 'user' and f.subject_id = c.uid))
       union all
       select a.resolved_at,
              coalesce((select array_agg(distinct f.signal) from integrity_flags f
                         where f.subject_type = 'session' and f.subject_id = c.sid
                           and f.created_at <= a.resolved_at), '{}')
         from appeals a
        where a.kind = 'integrity' and a.status = 'overturned' and a.resolved_at is not null
          and ((a.subject_type = 'session' and a.subject_id = c.sid)
            or (a.subject_type = 'integrity_flag' and a.subject_id in (
                  select f.id from integrity_flags f where f.subject_type = 'session' and f.subject_id = c.sid)))
       union all
       select a.resolved_at,
              coalesce((select array_agg(distinct f.signal) from integrity_flags f
                         where f.created_at <= a.resolved_at
                           and ((f.subject_type = 'user' and f.subject_id = c.uid)
                             or (f.subject_type = 'session' and f.subject_id in (
                                   select ps.id from playback_sessions ps where ps.user_id = c.uid)))), '{}')
         from appeals a
        where c.uid is not null and a.kind = 'integrity' and a.status = 'overturned' and a.resolved_at is not null
          and ((a.subject_type = 'user' and a.subject_id = c.uid)
            or (a.subject_type = 'integrity_flag' and a.subject_id in (
                  select f.id from integrity_flags f where f.subject_type = 'user' and f.subject_id = c.uid)))
     ) x
     where x.at >= c.started`)) as unknown as { sid: string; at: Date | string; codes: string[] | null }[];
  const bySession = new Map<string, AllowanceRow[]>();
  for (const r of result) {
    const list = bySession.get(r.sid) ?? [];
    list.push({ at: r.at instanceof Date ? r.at : new Date(r.at), codes: r.codes ?? [] });
    bySession.set(r.sid, list);
  }
  for (const [sid, rows] of bySession) {
    const merged = mergeAllowances(rows);
    if (merged) out.set(sid, merged);
  }
  return out;
}
