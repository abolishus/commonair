// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Database jobs the worker schedules. Each one is idempotent, records why it decided
 * what it did (`integrity_flags` rows with the signal, score and measured values, and
 * an `audit_log` row per action) and never deletes anything: excluded traffic is kept
 * with its reasons so it can be explained and appealed. Subject ids are the stable ids
 * of the excluded thing (session id, relay id, follower id + channel id).
 */
import { sql, type SQL } from "drizzle-orm";
import { KEYS } from "@commonair/contracts/internal";
import type { Database, Executor } from "@commonair/db";
import { schema } from "@commonair/db";
import type { ValkeyClient } from "@commonair/service";
import { HAS_ALLOWANCE, loadAllowances } from "./allowance.ts";
import { followBurst, type FollowFact } from "./channel.ts";
import { findSuperseded, type LiveSession, rankConcurrency, SUPERSEDE_DEFAULTS } from "./concurrency.ts";
import type { NetworkClassifier } from "./network.ts";
import { NOT_EVIDENCED, readP2pEvidence } from "./p2p.ts";
import { checkReceipt, relayStanding, type ReceiptHistoryEntry } from "./relay.ts";
import { scoreSession } from "./score.ts";
import { claimedSecondsUntil } from "./signals/fetch.ts";
import { readEvidence } from "./store.ts";
import { loadMinVerifiedViewers, loadThresholds } from "./thresholds.ts";
import type { FetchEvidence, SessionFacts, SessionScore, Verdict } from "./types.ts";

type Row = Record<string, unknown>;
const rows = (r: unknown) => r as Row[];
/** postgres.js cannot bind Date objects inside raw `sql` fragments; pass ISO text with a cast. */
const tsz = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
const json = (v: unknown): SQL => sql`${JSON.stringify(v)}::jsonb`;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const textOrNull = (v: unknown) => (typeof v === "string" ? v : null);
const date = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown) => (v === null || v === undefined ? null : date(v));

type FlagInsert = typeof schema.integrityFlags.$inferInsert;
type AuditInsert = typeof schema.auditLog.$inferInsert;

async function writeFlagsAndAudit(tx: Executor, flags: FlagInsert[], audits: AuditInsert[]): Promise<void> {
  if (flags.length) await tx.insert(schema.integrityFlags).values(flags);
  if (audits.length) await tx.insert(schema.auditLog).values(audits);
}

// Sessions ------------------------------------------------------------------------

export interface ScoreSessionsOptions {
  classifier?: NetworkClassifier;
  segmentDurationSeconds?: number;
  partsPerSegment?: number;
  /** Sessions per run (least recently scored first). */
  limit?: number;
  /** A session without a heartbeat for this long no longer counts as concurrent. */
  staleSeconds?: number;
  /** Ended sessions still pending are given a final score for this long after ending. */
  finalizeSeconds?: number;
  /** See `SupersedeOptions` in `concurrency.ts`. */
  supersedeGraceSeconds?: number;
}

export interface ScoreSessionsResult {
  scored: number;
  counts: Record<Verdict, number>;
  newlyExcluded: string[];
  /** Excluded sessions an allowance brought back. */
  restored: string[];
  /** Stale sessions replaced by a newer session of the same device and channel, now ended. */
  superseded: string[];
  /**
   * Server-side P2P evidence for this run (`p2p.ts`): sessions evidenced, and Valkey reads that
   * failed (those sessions were judged without the reduced share).
   */
  p2p: { evidenced: number; errors: number };
}

async function liveSessions(db: Executor, stale: Date): Promise<LiveSession[]> {
  // Two branches so each matches a partial index (`playback_sessions_live_hb_idx` for the first).
  const live = rows(
    await db.execute(sql`
      select id, device_hash, user_id, channel_id, started_at, last_heartbeat_at as seen
        from playback_sessions
       where ended_at is null and last_heartbeat_at > ${tsz(stale)}
      union all
      select id, device_hash, user_id, channel_id, started_at, started_at as seen
        from playback_sessions
       where ended_at is null and last_heartbeat_at is null and started_at > ${tsz(stale)}`),
  );
  return live.map((r) => ({
    id: String(r.id),
    deviceHash: String(r.device_hash),
    userId: textOrNull(r.user_id),
    channelId: String(r.channel_id),
    startedAt: date(r.started_at),
    lastSeenAt: date(r.seen),
  }));
}

/**
 * Smallest bytes one delivered media object can plausibly carry (a 200 ms LL-HLS part of
 * the audio-only rendition is ~1.6 kB). Caps what a receipt's entries can claim.
 */
export const MIN_RELAY_OBJECT_BYTES = 1000;

/**
 * Per-session object counts from each relay's receipts, and how far those receipts reach.
 * Only receipts verified against complete issuance count (status `verified` with a ratio;
 * pending, rejected and issuance-unknown receipts prove nothing). A receipt's entries can
 * claim at most `bytes_verified / MIN_RELAY_OBJECT_BYTES` objects in total: beyond that its
 * per-session counts are scaled down proportionally.
 */
export async function relayEvidence(
  db: Executor,
  sessions: readonly { id: string; relayId: string; startedAt: Date }[],
): Promise<{ objects: Map<string, number>; coveredUntil: Map<string, Date> }> {
  const objects = new Map<string, number>();
  const coveredUntil = new Map<string, Date>();
  if (sessions.length === 0) return { objects, coveredUntil };
  const relayIds = [...new Set(sessions.map((s) => s.relayId))];
  const since = new Date(Math.min(...sessions.map((s) => s.startedAt.getTime())));
  const proven = sql`
    select id, relay_id, period_end, bytes_verified, payload from relay_receipts
     where relay_id in (select jsonb_array_elements_text(${json(relayIds)})::uuid)
       and status = 'verified' and over_report_ratio is not null and period_end > ${tsz(since)}`;
  const coverage = rows(
    await db.execute(sql`select relay_id, max(period_end) as until from (${proven}) r group by relay_id`),
  );
  for (const c of coverage) coveredUntil.set(String(c.relay_id), date(c.until));
  const counts = rows(
    await db.execute(sql`
      with r as (${proven}),
      e as (
        select r.id, r.bytes_verified, x->>'sessionId' as sid, greatest(0, (x->>'segments')::bigint) as objs
          from r cross join lateral jsonb_array_elements(r.payload->'entries') x
      ),
      f as (
        select id, least(1.0, bytes_verified::float8 / nullif(sum(objs) * ${MIN_RELAY_OBJECT_BYTES}::float8, 0)) as factor
          from e group by id, bytes_verified
      )
      select e.sid, sum(e.objs * coalesce(f.factor, 0)) as objects
        from e join f on f.id = e.id
       where e.sid in (select jsonb_array_elements_text(${json(sessions.map((s) => s.id))}))
       group by e.sid`),
  );
  for (const c of counts) objects.set(String(c.sid), num(c.objects));
  return { objects, coveredUntil };
}

/** Sessions whose latest recorded heartbeat reported the page hidden. */
async function lastBeatHidden(valkey: ValkeyClient, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const evidence = await readEvidence(valkey, ids);
  for (const id of ids) {
    const beats = evidence.get(id)?.heartbeats ?? [];
    const last = beats.reduce<(typeof beats)[number] | null>((a, b) => (a === null || b.at >= a.at ? b : a), null);
    if (last && !last.visible) out.add(id);
  }
  return out;
}

/**
 * Score live sessions (and recently ended ones still pending). Exclusions are sticky: only
 * an allowance (overturned appeal or admin `allowed`, see `allowance.ts`) brings an excluded
 * session back into scoring. A verified session can still become excluded, or go back to
 * pending, as evidence accumulates. Sessions superseded by a reload are ended.
 */
export async function scoreActiveSessions(
  db: Database,
  valkey: ValkeyClient,
  now: Date,
  opts: ScoreSessionsOptions = {},
): Promise<ScoreSessionsResult> {
  const thresholds = await loadThresholds(db);
  const limit = opts.limit ?? 5000;
  const stale = new Date(now.getTime() - (opts.staleSeconds ?? 120) * 1000);
  const finalize = new Date(now.getTime() - (opts.finalizeSeconds ?? 3600) * 1000);
  const result: ScoreSessionsResult = {
    scored: 0,
    counts: { verified: 0, excluded: 0, pending: 0 },
    newlyExcluded: [],
    restored: [],
    superseded: [],
    p2p: { evidenced: 0, errors: 0 },
  };

  // `(ended_at is null or verdict = 'pending')` and the order match `playback_sessions_scoring_idx`.
  const candidates = rows(
    await db.execute(sql`
      select p.id, p.channel_id, p.user_id, p.device_hash, p.asn, p.datacenter, p.user_agent, p.fingerprint,
             p.assigned_source, p.relay_id, p.started_at, p.last_heartbeat_at, p.ended_at, p.heartbeats,
             p.watch_seconds, p.segments_fetched, p.bytes_http, p.bytes_p_2p, p.verdict
        from playback_sessions p
       where (p.ended_at is null or p.verdict = 'pending')
         and (p.ended_at is null or p.ended_at > ${tsz(finalize)})
         and p.started_at <= ${tsz(now)}
         and (p.verdict <> 'excluded' or ${HAS_ALLOWANCE})
       order by p.scored_at nulls first, p.id
       limit ${limit}`),
  );

  const live = await liveSessions(db, stale);
  // A session that went quiet when a newer one on the same device and channel started is not
  // counted toward concurrency at once; it is ended only after the grace period.
  const quietCandidates = findSuperseded(live, now, { ...SUPERSEDE_DEFAULTS, graceMs: 0 });
  const hidden = await lastBeatHidden(valkey, [...quietCandidates]);
  const quiet = findSuperseded(live, now, { ...SUPERSEDE_DEFAULTS, graceMs: 0 }, hidden);
  const superseded = findSuperseded(
    live,
    now,
    { ...SUPERSEDE_DEFAULTS, graceMs: (opts.supersedeGraceSeconds ?? SUPERSEDE_DEFAULTS.graceMs / 1000) * 1000 },
    hidden,
  );
  const concurrency = rankConcurrency(live, quiet);

  if (candidates.length > 0) {
    const facts: (SessionFacts & { relayId: string | null; endedAt: Date | null; previous: string })[] = candidates.map(
      (c) => ({
        id: String(c.id),
        channelId: String(c.channel_id),
        userId: textOrNull(c.user_id),
        deviceHash: String(c.device_hash),
        asn: c.asn === null ? null : Number(c.asn),
        datacenter: textOrNull(c.datacenter),
        userAgent: textOrNull(c.user_agent),
        fingerprint: (c.fingerprint as Record<string, unknown> | null) ?? {},
        assignedSource: c.assigned_source as SessionFacts["assignedSource"],
        relayId: textOrNull(c.relay_id),
        endedAt: dateOrNull(c.ended_at),
        startedAt: date(c.started_at),
        lastHeartbeatAt: dateOrNull(c.last_heartbeat_at),
        heartbeats: num(c.heartbeats),
        watchSeconds: num(c.watch_seconds),
        segmentsFetched: num(c.segments_fetched),
        bytesHttp: num(c.bytes_http),
        bytesP2p: num(c.bytes_p_2p),
        previous: String(c.verdict),
      }),
    );
    const [evidence, allowances, relay, p2p] = await Promise.all([
      readEvidence(
        valkey,
        facts.map((f) => f.id),
      ),
      loadAllowances(db, facts),
      relayEvidence(
        db,
        facts.flatMap((f) =>
          f.assignedSource === "relay" && f.relayId ? [{ id: f.id, relayId: f.relayId, startedAt: f.startedAt }] : [],
        ),
      ),
      // CDN sessions are not fetch-judged, so their P2P evidence would change nothing.
      readP2pEvidence(
        valkey,
        facts.flatMap((f) =>
          f.assignedSource === "cdn"
            ? []
            : [{ id: f.id, channelId: f.channelId, at: Math.min(now.getTime(), (f.endedAt ?? now).getTime()) }],
        ),
      ),
    ]);
    result.p2p.errors = p2p.errors;
    for (const e of p2p.evidence.values()) if (e.evidenced) result.p2p.evidenced++;

    const scored: { facts: (typeof facts)[number]; score: SessionScore; allowed: boolean }[] = facts.map((f) => {
      const ev = evidence.get(f.id);
      const beats = ev?.heartbeats ?? [];
      let fetches: FetchEvidence;
      if (f.assignedSource === "relay") {
        // No proven coverage yet: null holds the session pending until receipts arrive (ended
        // pending sessions stay candidates for `finalizeSeconds`, so late receipts still count).
        const until = f.relayId ? relay.coveredUntil.get(f.relayId) : undefined;
        fetches =
          until && until > f.startedAt
            ? {
                relayObjects: relay.objects.get(f.id) ?? 0,
                claimedSeconds: claimedSecondsUntil(beats, until.getTime(), f),
              }
            : null;
      } else if (f.assignedSource === "cdn") {
        fetches = null;
      } else {
        fetches = ev?.fetches ?? { playlists: null, segments: f.segmentsFetched, parts: null };
      }
      const conc = concurrency.get(f.id);
      const allowance = allowances.get(f.id) ?? null;
      const score = scoreSession(
        f,
        beats,
        fetches,
        {
          sessionExcludeScore: thresholds.sessionExcludeScore,
          maxSessionsPerDevice: thresholds.maxSessionsPerDevice,
          device: conc?.device ?? { rank: 1, concurrent: 1 },
          account: f.userId === null ? null : (conc?.account ?? { rank: 1, concurrent: 1 }),
          segmentDurationSeconds: opts.segmentDurationSeconds ?? 1,
          partsPerSegment: opts.partsPerSegment ?? 5,
          allowance,
          p2p: p2p.evidence.get(f.id) ?? NOT_EVIDENCED,
        },
        opts.classifier,
      );
      return { facts: f, score, allowed: allowance !== null };
    });
    // An excluded session that stays excluded keeps its verdict and flags; only `scored_at`
    // moves, so it rotates to the back of the queue instead of starving the rest.
    const stillExcluded = scored.filter((s) => s.facts.previous === "excluded" && s.score.verdict === "excluded");
    const writes = scored.filter((s) => !(s.facts.previous === "excluded" && s.score.verdict === "excluded"));

    await db.transaction(async (tx) => {
      if (stillExcluded.length) {
        await tx.execute(sql`
          update playback_sessions set scored_at = ${tsz(now)}
           where id in (select jsonb_array_elements_text(${json(stillExcluded.map((s) => s.facts.id))})::uuid)`);
      }
      const updated = writes.length
        ? rows(
            await tx.execute(sql`
              update playback_sessions p
                 set verdict = v.verdict::session_verdict,
                     verdict_reasons = array(select jsonb_array_elements_text(v.reasons)),
                     score = v.score,
                     scored_at = ${tsz(now)}
                from jsonb_to_recordset(${json(
                  writes.map((s) => ({
                    id: s.facts.id,
                    verdict: s.score.verdict,
                    reasons: s.score.reasons,
                    score: s.score.score,
                    allowed: s.allowed,
                  })),
                )}) as v(id uuid, verdict text, reasons jsonb, score float8, allowed boolean)
               where p.id = v.id and (p.verdict <> 'excluded' or v.allowed)
              returning p.id`),
          )
        : [];
      const written = new Set(updated.map((r) => String(r.id)));
      const flags: FlagInsert[] = [];
      const audits: AuditInsert[] = [];
      for (const s of writes) {
        if (!written.has(s.facts.id)) continue;
        result.scored++;
        result.counts[s.score.verdict]++;
        if (s.facts.previous === "excluded") {
          result.restored.push(s.facts.id);
          audits.push({
            actorType: "system",
            action: "integrity.session.restore",
            subjectType: "session",
            subjectId: s.facts.id,
            channelId: s.facts.channelId,
            reason: "allowed_on_appeal",
            details: { verdict: s.score.verdict, score: s.score.score, reasons: s.score.reasons },
          });
          continue;
        }
        if (s.score.verdict !== "excluded") continue;
        result.newlyExcluded.push(s.facts.id);
        for (const sig of s.score.signals) {
          flags.push({
            subjectType: "session",
            subjectId: s.facts.id,
            channelId: s.facts.channelId,
            signal: sig.code,
            score: sig.score,
            details: { ...sig.details, sessionScore: s.score.score, threshold: thresholds.sessionExcludeScore },
            decision: "excluded",
          });
        }
        audits.push({
          actorType: "system",
          action: "integrity.session.exclude",
          subjectType: "session",
          subjectId: s.facts.id,
          channelId: s.facts.channelId,
          reason: s.score.reasons.join(","),
          details: {
            score: s.score.score,
            threshold: thresholds.sessionExcludeScore,
            previousVerdict: s.facts.previous,
          },
        });
      }
      await writeFlagsAndAudit(tx, flags, audits);
    });
  }

  if (superseded.size > 0) {
    const ended = await db.transaction(async (tx) => {
      const r = rows(
        await tx.execute(sql`
          update playback_sessions set ended_at = coalesce(last_heartbeat_at, started_at)
           where id in (select jsonb_array_elements_text(${json([...superseded])})::uuid) and ended_at is null
          returning id, channel_id, device_hash, ended_at`),
      );
      if (r.length) {
        await tx.insert(schema.auditLog).values(
          r.map((x): AuditInsert => ({
            actorType: "system",
            action: "integrity.session.supersede",
            subjectType: "session",
            subjectId: String(x.id),
            channelId: String(x.channel_id),
            reason: "replaced by a newer session of the same device and channel",
            details: { endedAt: date(x.ended_at).toISOString() },
          })),
        );
      }
      return r;
    });
    const byChannel = new Map<string, string[]>();
    for (const r of ended) {
      result.superseded.push(String(r.id));
      byChannel.set(String(r.channel_id), [...(byChannel.get(String(r.channel_id)) ?? []), String(r.id)]);
    }
    // Drop them from the live heartbeat sets right away (as the stale-session job does).
    for (const [channelId, ids] of byChannel) await valkey.zrem(KEYS.viewers(channelId), ...ids);
  }
  return result;
}

// Relay receipts --------------------------------------------------------------------

export interface VerifyReceiptsOptions {
  /** Wait this long after a receipt's period ends, so the issuance log for it is complete. */
  graceSeconds?: number;
  limit?: number;
  /**
   * When given, relays suspended by this run are removed from `KEYS.relays` right after the
   * suspension commits, so assignment stops at once rather than on the relay's next heartbeat.
   */
  valkey?: ValkeyClient;
}

export interface VerifyReceiptsResult {
  verified: number;
  rejected: number;
  /** Verified for issued bytes only because the issuance record had gaps (not counted against the relay). */
  unknown: number;
  suspendedRelays: string[];
  /** Suspended relays whose removal from `KEYS.relays` failed (they leave on their next heartbeat). */
  deassignFailed: number;
}

/**
 * Check pending receipts against `relay_issuance` for the minutes they cover, then
 * suspend relays whose recent history shows repeated or gross over-reporting.
 *
 * Issuance is incomplete for a receipt when some minute of its period had live sessions
 * assigned to the relay but the origin issued this relay nothing in that minute (no issuance
 * row with bytes for it: the origin was down, or lost the production record of the broadcast
 * those sessions watched). Issuance is computed for every relay with live sessions, so such a
 * minute is missing data, not proof; another relay's issuance (another broadcast's production)
 * says nothing about it. A minute without live sessions on the relay and without issuance is
 * real: nothing was issued to it. Incomplete receipts are "unknown", never over-reports. Standing only
 * looks at periods that started at or after the relay's latest reinstatement
 * (`relay.reinstate` audit row).
 */
export async function verifyReceipts(
  db: Database,
  now: Date,
  opts: VerifyReceiptsOptions = {},
): Promise<VerifyReceiptsResult> {
  const thresholds = await loadThresholds(db);
  const tolerance = thresholds.relayOverReportTolerance;
  const cutoff = new Date(now.getTime() - (opts.graceSeconds ?? 120) * 1000);
  const result: VerifyReceiptsResult = {
    verified: 0,
    rejected: 0,
    unknown: 0,
    suspendedRelays: [],
    deassignFailed: 0,
  };

  await db.transaction(async (tx) => {
    const pending = rows(
      await tx.execute(sql`
        select r.id, r.relay_id, r.period_start, r.period_end, r.bytes_reported,
               (select sum(i.bytes_issued) from relay_issuance i
                 where i.relay_id = r.relay_id and i.bucket_start >= date_trunc('minute', r.period_start)
                   and i.bucket_start < r.period_end) as bytes_issued,
               (select count(*) from generate_series(date_trunc('minute', r.period_start),
                                                     r.period_end - interval '1 microsecond',
                                                     interval '1 minute') m
                 where exists (select 1 from playback_sessions ps
                                where ps.relay_id = r.relay_id and ps.assigned_source = 'relay'
                                  and ps.started_at < m + interval '1 minute' and ps.last_heartbeat_at >= m
                                  and (ps.ended_at is null or ps.ended_at >= m))
                   and not exists (select 1 from relay_issuance i
                                    where i.relay_id = r.relay_id and i.bucket_start = m
                                      and i.bytes_issued > 0)
               ) as gap_minutes
          from relay_receipts r
         where r.status = 'pending' and r.period_end <= ${tsz(cutoff)}
         order by r.period_end, r.id
         limit ${opts.limit ?? 1000}
           for update of r skip locked`),
    );
    if (pending.length === 0) return;

    const checks = pending.map((p) => {
      const issued = p.bytes_issued === null ? null : num(p.bytes_issued);
      const gaps = num(p.gap_minutes);
      return { p, issued, gaps, check: checkReceipt(num(p.bytes_reported), issued, tolerance, gaps === 0) };
    });
    await tx.execute(sql`
      update relay_receipts r
         set status = v.status::receipt_status, bytes_verified = v.bytes_verified, over_report_ratio = v.ratio,
             checked_at = ${tsz(now)}, rejection_reason = v.reason
        from jsonb_to_recordset(${json(
          checks.map(({ p, check }) => ({
            id: p.id,
            status: check.status,
            bytes_verified: check.bytesVerified,
            ratio: check.overReportRatio,
            reason: check.status === "rejected" ? check.reason : null,
          })),
        )}) as v(id uuid, status text, bytes_verified bigint, ratio float8, reason text)
       where r.id = v.id and r.status = 'pending'`);

    const flags: FlagInsert[] = [];
    const audits: AuditInsert[] = [];
    for (const { p, issued, gaps, check } of checks) {
      const base = {
        receiptId: String(p.id),
        bytesReported: num(p.bytes_reported),
        bytesIssued: issued,
        tolerance,
      };
      if (check.status === "verified") {
        result.verified++;
        if (check.issuance === "unknown") {
          result.unknown++;
          flags.push({
            subjectType: "relay",
            subjectId: String(p.relay_id),
            signal: "relay_issuance_unknown",
            score: 0,
            details: { ...base, gapMinutes: gaps, bytesVerified: check.bytesVerified },
            decision: "pending_review",
          });
        }
        continue;
      }
      result.rejected++;
      const details = { ...base, reason: check.reason, overReportRatio: check.overReportRatio };
      flags.push({
        subjectType: "relay",
        subjectId: String(p.relay_id),
        signal: "relay_over_report",
        score: 1,
        details,
        decision: "excluded",
      });
      audits.push({
        actorType: "system",
        action: "integrity.receipt.reject",
        subjectType: "relay_receipt",
        subjectId: String(p.id),
        reason: check.reason,
        details: { ...details, relayId: String(p.relay_id) },
      });
    }

    const relayIds = [...new Set(pending.map((p) => String(p.relay_id)))];
    for (const relayId of relayIds) {
      const [reinstated] = rows(
        await tx.execute(sql`
          select max(created_at) as at from audit_log
           where subject_type = 'relay' and subject_id = ${relayId} and action = 'relay.reinstate'`),
      );
      const since = dateOrNull(reinstated?.at);
      const history = rows(
        await tx.execute(sql`
          select period_start, period_end, status, over_report_ratio from relay_receipts
           where relay_id = ${relayId}::uuid and status in ('verified', 'rejected')
             ${since ? sql`and period_start >= ${tsz(since)}` : sql``}
           order by period_end desc limit 5`),
      ).map((h): ReceiptHistoryEntry => ({
        periodStart: date(h.period_start),
        periodEnd: date(h.period_end),
        status: h.status as ReceiptHistoryEntry["status"],
        overReportRatio: h.over_report_ratio === null ? null : Number(h.over_report_ratio),
      }));
      const standing = relayStanding(history, tolerance, since);
      if (!standing.suspend) continue;
      const suspended = rows(
        await tx.execute(sql`
          update relay_nodes set status = 'suspended', suspended_at = ${tsz(now)},
                 suspended_reason = ${`integrity:${standing.reason ?? "over_report"}`}, updated_at = ${tsz(now)}
           where id = ${relayId}::uuid and status <> 'suspended'
          returning id`),
      );
      if (suspended.length === 0) continue;
      result.suspendedRelays.push(relayId);
      const details = { ...standing, tolerance, since: since?.toISOString() ?? null };
      flags.push({
        subjectType: "relay",
        subjectId: relayId,
        signal: "relay_suspended",
        score: 1,
        details,
        decision: "excluded",
      });
      audits.push({
        actorType: "system",
        action: "integrity.relay.suspend",
        subjectType: "relay",
        subjectId: relayId,
        reason: standing.reason ?? "over_report",
        details,
      });
    }
    await writeFlagsAndAudit(tx, flags, audits);
  });
  // A concurrent relay heartbeat that read `active` before this commit may HSET `KEYS.relays`
  // after this HDEL; the API re-reads the row after its HSET and drops the entry again
  // (services/api `publishRelay`), so the suspension sticks.
  if (opts.valkey && result.suspendedRelays.length > 0) {
    try {
      await opts.valkey.hdel(KEYS.relays, ...result.suspendedRelays);
    } catch {
      // The suspension is committed; the API drops a non-active relay on its next heartbeat.
      result.deassignFailed = result.suspendedRelays.length;
    }
  }
  return result;
}

// Follows ----------------------------------------------------------------------------

export interface FollowBurstJobOptions {
  windowMinutes?: number;
  minAccountAgeDays?: number;
}

export interface FollowBurstJobResult {
  channels: string[];
  excluded: { followerId: string; channelId: string }[];
}

/**
 * Exclude low-quality follows that arrived in bursts (`follows.excluded_at`; rows are kept).
 * Prior viewing counts verified sessions only: a botted session cannot vouch for a follow.
 */
export async function excludeFollowBursts(
  db: Database,
  now: Date,
  opts: FollowBurstJobOptions = {},
): Promise<FollowBurstJobResult> {
  const thresholds = await loadThresholds(db);
  const from = new Date(now.getTime() - (opts.windowMinutes ?? 60) * 60_000);
  const minAccountAgeDays = opts.minAccountAgeDays ?? 7;
  const result: FollowBurstJobResult = { channels: [], excluded: [] };

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('commonair:follow-bursts'))`);
    const facts: FollowFact[] = rows(
      await tx.execute(sql`
        select f.follower_id, f.channel_id, f.created_at, f.excluded_at, u.created_at as account_created_at,
               -- Watch time can only vouch for a follow up to the moment of the follow.
               coalesce((select sum(least(ps.watch_seconds,
                                          greatest(0, extract(epoch from (f.created_at - ps.started_at)))))
                           from playback_sessions ps
                          where ps.user_id = f.follower_id and ps.channel_id = f.channel_id
                            and ps.verdict = 'verified' and ps.started_at < f.created_at), 0) as prior_seconds
          from follows f join users u on u.id = f.follower_id
         where f.created_at >= ${tsz(from)} and f.created_at < ${tsz(now)}`),
    ).map((r) => ({
      followerId: String(r.follower_id),
      channelId: String(r.channel_id),
      createdAt: date(r.created_at),
      accountCreatedAt: date(r.account_created_at),
      priorViewingSeconds: num(r.prior_seconds),
      alreadyExcluded: r.excluded_at !== null,
    }));

    const byChannel = new Map<string, FollowFact[]>();
    for (const f of facts) byChannel.set(f.channelId, [...(byChannel.get(f.channelId) ?? []), f]);

    const flags: FlagInsert[] = [];
    const audits: AuditInsert[] = [];
    const toExclude: { follower_id: string; channel_id: string }[] = [];
    for (const [channelId, list] of byChannel) {
      const { bursts, excluded } = followBurst(list, { perMinute: thresholds.followBurstPerMinute, minAccountAgeDays });
      if (excluded.length === 0) continue;
      result.channels.push(channelId);
      for (const f of excluded) {
        toExclude.push({ follower_id: f.followerId, channel_id: channelId });
        result.excluded.push({ followerId: f.followerId, channelId });
        flags.push({
          subjectType: "follow",
          subjectId: f.followerId,
          channelId,
          signal: "follow_burst",
          score: 1,
          details: {
            followedAt: f.createdAt.toISOString(),
            accountAgeDays: Math.floor((f.createdAt.getTime() - f.accountCreatedAt.getTime()) / 86_400_000),
            priorViewingSeconds: f.priorViewingSeconds,
            perMinute: thresholds.followBurstPerMinute,
          },
          decision: "excluded",
        });
      }
      const burstDetails = bursts.map((b) => ({ ...b, minuteStart: b.minuteStart.toISOString() }));
      flags.push({
        subjectType: "channel",
        subjectId: channelId,
        channelId,
        signal: "follow_burst",
        score: 1,
        details: { bursts: burstDetails, excluded: excluded.length },
        decision: "excluded",
      });
      audits.push({
        actorType: "system",
        action: "integrity.follows.exclude",
        subjectType: "channel",
        subjectId: channelId,
        channelId,
        reason: "follow_burst",
        details: { excluded: excluded.length, bursts: burstDetails, minAccountAgeDays },
      });
    }
    if (toExclude.length) {
      await tx.execute(sql`
        update follows f set excluded_at = ${tsz(now)}
          from jsonb_to_recordset(${json(toExclude)}) as v(follower_id uuid, channel_id uuid)
         where f.follower_id = v.follower_id and f.channel_id = v.channel_id and f.excluded_at is null`);
    }
    await writeFlagsAndAudit(tx, flags, audits);
  });
  return result;
}

// Stream hours -------------------------------------------------------------------------

export interface StreamHoursResult {
  updated: number;
  eligible: number;
}

/**
 * Recompute `stream_hours.verified_other_viewers` and `eligible` for recent hours. An hour
 * is eligible when at least `membership.classes.streamer.minVerifiedViewers` distinct
 * viewers (account, else device) with a verified session overlapped it, none of them the
 * streamer. The streamer is recognised by user id, by the devices the streamer watched from
 * while signed in during the last 30 days, and by network, time-aligned so a shared address
 * (a campus, a café) only counts against viewers while the streamer is there:
 *
 *   - the address hash of a session of the streamer that overlapped the judged hour ± 1 h;
 *   - a stream key's `last_used_ip_hash` (the ingest address) when the key was last used
 *     during that broadcast (from 10 minutes before its start).
 */
export async function markEligibleStreamHours(
  db: Database,
  now: Date,
  opts: { lookbackHours?: number } = {},
): Promise<StreamHoursResult> {
  const from = new Date(now.getTime() - (opts.lookbackHours ?? 48) * 3_600_000);
  const ownerDevicesSince = new Date(from.getTime() - 30 * 86_400_000);
  const minViewers = await loadMinVerifiedViewers(db);
  return db.transaction(async (tx) => {
    const changed = rows(
      await tx.execute(sql`
        with hours as (
          select sh.broadcast_id, sh.hour_start, sh.channel_id, c.owner_id
            from stream_hours sh join channels c on c.id = sh.channel_id
           where sh.hour_start >= ${tsz(from)} and sh.hour_start < ${tsz(now)}
        ),
        owner_devices as (
          select distinct ps.user_id as owner_id, ps.device_hash from playback_sessions ps
           where ps.user_id in (select owner_id from hours) and ps.started_at >= ${tsz(ownerDevicesSince)}
        ),
        counts as (
          select h.broadcast_id, h.hour_start,
                 count(distinct coalesce(ps.user_id::text, 'device:' || ps.device_hash)) as n
            from hours h
            join playback_sessions ps
              on ps.channel_id = h.channel_id and ps.verdict = 'verified'
             and ps.started_at < h.hour_start + interval '1 hour'
             and coalesce(ps.ended_at, ps.last_heartbeat_at, ps.started_at) > h.hour_start
           where ps.user_id is distinct from h.owner_id
             and not exists (select 1 from owner_devices od
                              where od.owner_id = h.owner_id and od.device_hash = ps.device_hash)
             and not exists (select 1 from playback_sessions o
                              where o.user_id = h.owner_id and o.ip_hash = ps.ip_hash
                                and o.started_at < h.hour_start + interval '2 hours'
                                and coalesce(o.ended_at, o.last_heartbeat_at, o.started_at)
                                    > h.hour_start - interval '1 hour')
             and not exists (select 1 from stream_keys sk join broadcasts b on b.id = h.broadcast_id
                              where sk.channel_id = h.channel_id and sk.last_used_ip_hash = ps.ip_hash
                                and sk.last_used_at >= b.started_at - interval '10 minutes'
                                and sk.last_used_at <= coalesce(b.ended_at, ${tsz(now)}))
           group by h.broadcast_id, h.hour_start
        )
        update stream_hours sh
           set verified_other_viewers = coalesce(c.n, 0), eligible = coalesce(c.n, 0) >= ${minViewers}::int
          from hours h left join counts c on c.broadcast_id = h.broadcast_id and c.hour_start = h.hour_start
         where sh.broadcast_id = h.broadcast_id and sh.hour_start = h.hour_start
           and (sh.verified_other_viewers is distinct from coalesce(c.n, 0)
                or sh.eligible is distinct from (coalesce(c.n, 0) >= ${minViewers}::int))
        returning sh.broadcast_id, sh.eligible`),
    );
    const eligible = changed.filter((r) => r.eligible === true).length;
    if (changed.length > 0) {
      await tx.insert(schema.auditLog).values({
        actorType: "system",
        action: "integrity.stream_hours.mark",
        subjectType: "stream_hours",
        subjectId: `${from.toISOString()}/${now.toISOString()}`,
        reason: "verified viewers other than the streamer",
        details: {
          updated: changed.length,
          eligible,
          minVerifiedViewers: minViewers,
          broadcasts: [...new Set(changed.map((r) => String(r.broadcast_id)))],
        },
      });
    }
    return { updated: changed.length, eligible };
  });
}
