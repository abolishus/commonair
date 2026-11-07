// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the integrity scorer decided about a scenario's own sessions, read from Postgres when a
 * viewer count does not converge (viewers, integrity-basic). Each session's verdict, reasons,
 * counters and flags, and for each flag how many seconds into the session it was raised: an honest
 * session excluded seconds after it started, before its first heartbeat (due about 10 s in), is a
 * scorer judging start-up, not a bot (main CI run
 * 41812379909: a Chromium viewer excluded on `playlists_without_segments` 3.6 s in, then sticky
 * for the whole run). Session ids only, no personal data.
 */

/** One flag on a session, as `integrity_flags` holds it. */
export interface SessionFlag {
  signal: string;
  score: number;
  details: Record<string, unknown>;
  /** Seconds from the session's start to the flag. */
  after_s: number | null;
}

export interface SessionVerdictRow {
  id: string;
  verdict: string;
  reasons: string[] | null;
  score: number | null;
  source: string | null;
  heartbeats: number;
  watch_seconds: number;
  segments_fetched: number;
  bytes_http: number;
  bytes_p2p: number;
  ended: boolean;
  /** Seconds since the session started, now. */
  age_s: number | null;
  flags: SessionFlag[];
}

/** A scenario's viewer: how the report names it and the session it opened (null: none). */
export interface ViewerSession {
  label: string;
  kind: string;
  sessionId: string | null;
}

export type ReportedSession = { viewer: string; kind: string } & (
  | SessionVerdictRow
  | { id: string | null; verdict: "missing" | "no session" }
);

export interface VerdictReport {
  sessions: ReportedSession[];
  /** Sessions whose verdict is not `expect` (verified for honest viewers), with all their facts. */
  unexpected: ReportedSession[];
  /** `<label>:<kind>:<verdict>` for every session, in viewer order. */
  verdicts: string[];
  /**
   * Unexpected sessions with a start-up flag (`isStartupFlag`): what a scorer judging start-up
   * looks like (see the module comment). `afterS` is the earliest such flag's time, if known.
   */
  flaggedAtStartup: { viewer: string; id: string; afterS: number | null; signals: string[] }[];
}

/** A flag this early in a session is start-up: the first heartbeat is due about 10 s in. */
export const STARTUP_SECONDS = 10;

/**
 * A flag raised at start-up: within `startupSeconds` of the session's start, or, whenever it was
 * raised, judged with nothing expected yet (`expectedSegments: 0`, no watch time credited). The
 * clock alone misses a player whose first heartbeat is late, so the scorer's own measure counts too.
 */
export function isStartupFlag(flag: SessionFlag, startupSeconds = STARTUP_SECONDS): boolean {
  if (flag.after_s !== null && flag.after_s <= startupSeconds) return true;
  return flag.details["expectedSegments"] === 0;
}

/** Pure: lines the rows up with the viewers that opened them. */
export function verdictReport(
  viewers: readonly ViewerSession[],
  rows: readonly SessionVerdictRow[],
  expect: "verified" | "excluded" = "verified",
  startupSeconds = STARTUP_SECONDS,
): VerdictReport {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sessions: ReportedSession[] = viewers.map((v) => {
    const base = { viewer: v.label, kind: v.kind };
    if (v.sessionId === null) return { ...base, id: null, verdict: "no session" as const };
    const row = byId.get(v.sessionId);
    return row ? { ...base, ...row } : { ...base, id: v.sessionId, verdict: "missing" as const };
  });
  const unexpected = sessions.filter((s) => s.verdict !== expect);
  const flaggedAtStartup: VerdictReport["flaggedAtStartup"] = [];
  for (const s of unexpected) {
    if (!("flags" in s) || s.id === null) continue;
    const early = s.flags.filter((f) => isStartupFlag(f, startupSeconds));
    if (early.length === 0) continue;
    const times = early.map((f) => f.after_s).filter((t): t is number => t !== null);
    flaggedAtStartup.push({
      viewer: s.viewer,
      id: s.id,
      afterS: times.length > 0 ? Math.min(...times) : null,
      signals: early.map((f) => f.signal),
    });
  }
  return {
    sessions,
    unexpected,
    verdicts: sessions.map((s) => `${s.viewer}:${s.kind}:${s.verdict}`),
    flaggedAtStartup,
  };
}

/** Each session's verdict, counters and flags (with when each flag was raised). */
export async function readSessionVerdicts(url: string, ids: readonly string[]): Promise<SessionVerdictRow[]> {
  if (ids.length === 0) return [];
  const sql = new Bun.SQL(url);
  try {
    return (await sql`
      select p.id, p.verdict::text as verdict, p.verdict_reasons as reasons, p.score::float8 as score,
             p.assigned_source::text as source, p.heartbeats, p.watch_seconds, p.segments_fetched,
             p.bytes_http::float8 as bytes_http, p.bytes_p_2p::float8 as bytes_p2p,
             p.ended_at is not null as ended,
             round(extract(epoch from (now() - p.started_at))::numeric, 1)::float8 as age_s,
             coalesce((select jsonb_agg(jsonb_build_object(
                                 'signal', f.signal, 'score', f.score, 'details', f.details,
                                 'after_s', round(extract(epoch from (f.created_at - p.started_at))::numeric, 1))
                               order by f.created_at)
                         from integrity_flags f
                        where f.subject_type = 'session' and f.subject_id = p.id), '[]'::jsonb) as flags
        from playback_sessions p where p.id = any(${sql.array([...ids], "uuid")})`) as SessionVerdictRow[];
  } finally {
    await sql.close();
  }
}

/** Reads and lines up the sessions of `viewers` (those without a session are reported as such). */
export async function sessionVerdicts(
  url: string,
  viewers: readonly ViewerSession[],
  expect: "verified" | "excluded" = "verified",
): Promise<VerdictReport> {
  const ids = viewers.map((v) => v.sessionId).filter((id): id is string => id !== null);
  return verdictReport(viewers, await readSessionVerdicts(url, ids), expect);
}
