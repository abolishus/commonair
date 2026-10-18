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
import type { Database, Executor } from "@commonair/db";
import { schema } from "@commonair/db";
import type { ValkeyClient } from "@commonair/service";
import { followBurst, type FollowFact } from "./channel.ts";
import type { NetworkClassifier } from "./network.ts";
import { checkReceipt, relayStanding, type ReceiptHistoryEntry } from "./relay.ts";
import { scoreSession } from "./score.ts";
import { readEvidence } from "./store.ts";
import { loadThresholds } from "./thresholds.ts";
import type { FetchSummary, SessionFacts, SessionScore, Verdict } from "./types.ts";

type Row = Record<string, unknown>;
const rows = (r: unknown) => r as Row[];
/** postgres.js cannot bind Date objects inside raw `sql` fragments; pass ISO text with a cast. */
const tsz = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
const json = (v: unknown): SQL => sql`${JSON.stringify(v)}::jsonb`;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const textOrNull = (v: unknown) => (typeof v === "string" ? v : null);
const date = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

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
  /** Sessions per run (oldest first). */
  limit?: number;
  /** A session without a heartbeat for this long no longer counts as concurrent. */
  staleSeconds?: number;
  /** Ended sessions still pending are given a final score for this long after ending. */
  finalizeSeconds?: number;
}

export interface ScoreSessionsResult {
  scored: number;
  counts: Record<Verdict, number>;
  newlyExcluded: string[];
}

/**
 * Score live sessions (and recently ended ones still pending). Verdicts are sticky once
 * `excluded`: only an appeal overturns one. A verified session can still become excluded
 * as evidence accumulates (e.g. perfectly periodic timing after 10 beats).
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

  const candidates = rows(
    await db.execute(sql`
      with concurrent as (
        select id,
               row_number() over (partition by device_hash order by started_at, id) as dev_rank,
               count(*) over (partition by device_hash) as dev_n,
               row_number() over (partition by user_id order by started_at, id) as acc_rank,
               count(*) over (partition by user_id) as acc_n
          from playback_sessions
         where ended_at is null and coalesce(last_heartbeat_at, started_at) > ${tsz(stale)}
      )
      select p.id, p.channel_id, p.user_id, p.device_hash, p.asn, p.datacenter, p.user_agent, p.fingerprint,
             p.assigned_source, p.started_at, p.heartbeats, p.watch_seconds, p.segments_fetched, p.bytes_http,
             p.bytes_p_2p, p.verdict, c.dev_rank, c.dev_n, c.acc_rank, c.acc_n
        from playback_sessions p
        left join concurrent c on c.id = p.id
       where p.verdict <> 'excluded' and p.started_at <= ${tsz(now)}
         and (p.ended_at is null or (p.verdict = 'pending' and p.ended_at > ${tsz(finalize)}))
       order by p.started_at, p.id
       limit ${limit}`),
  );
  const result: ScoreSessionsResult = {
    scored: 0,
    counts: { verified: 0, excluded: 0, pending: 0 },
    newlyExcluded: [],
  };
  if (candidates.length === 0) return result;

  const evidence = await readEvidence(
    valkey,
    candidates.map((c) => String(c.id)),
  );
  const scored: { facts: SessionFacts; previous: string; score: SessionScore }[] = candidates.map((c) => {
    const facts: SessionFacts = {
      id: String(c.id),
      channelId: String(c.channel_id),
      userId: textOrNull(c.user_id),
      deviceHash: String(c.device_hash),
      asn: c.asn === null ? null : Number(c.asn),
      datacenter: textOrNull(c.datacenter),
      userAgent: textOrNull(c.user_agent),
      fingerprint: (c.fingerprint as Record<string, unknown> | null) ?? {},
      assignedSource: c.assigned_source as SessionFacts["assignedSource"],
      startedAt: date(c.started_at),
      heartbeats: num(c.heartbeats),
      watchSeconds: num(c.watch_seconds),
      segmentsFetched: num(c.segments_fetched),
      bytesHttp: num(c.bytes_http),
      bytesP2p: num(c.bytes_p_2p),
    };
    const ev = evidence.get(facts.id);
    const fetches: FetchSummary = ev?.fetches ?? { playlists: null, segments: facts.segmentsFetched, parts: null };
    const score = scoreSession(
      facts,
      ev?.heartbeats ?? [],
      fetches,
      {
        sessionExcludeScore: thresholds.sessionExcludeScore,
        maxSessionsPerDevice: thresholds.maxSessionsPerDevice,
        device: c.dev_rank === null ? { rank: 1, concurrent: 1 } : { rank: num(c.dev_rank), concurrent: num(c.dev_n) },
        account:
          facts.userId === null
            ? null
            : c.acc_rank === null
              ? { rank: 1, concurrent: 1 }
              : { rank: num(c.acc_rank), concurrent: num(c.acc_n) },
        segmentDurationSeconds: opts.segmentDurationSeconds ?? 1,
        partsPerSegment: opts.partsPerSegment ?? 5,
      },
      opts.classifier,
    );
    return { facts, previous: String(c.verdict), score };
  });

  await db.transaction(async (tx) => {
    const updated = rows(
      await tx.execute(sql`
        update playback_sessions p
           set verdict = v.verdict::session_verdict,
               verdict_reasons = array(select jsonb_array_elements_text(v.reasons)),
               score = v.score,
               scored_at = ${tsz(now)}
          from jsonb_to_recordset(${json(
            scored.map((s) => ({
              id: s.facts.id,
              verdict: s.score.verdict,
              reasons: s.score.reasons,
              score: s.score.score,
            })),
          )}) as v(id uuid, verdict text, reasons jsonb, score float8)
         where p.id = v.id and p.verdict <> 'excluded'
        returning p.id`),
    );
    const written = new Set(updated.map((r) => String(r.id)));
    const flags: FlagInsert[] = [];
    const audits: AuditInsert[] = [];
    for (const s of scored) {
      if (!written.has(s.facts.id)) continue;
      result.scored++;
      result.counts[s.score.verdict]++;
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
        details: { score: s.score.score, threshold: thresholds.sessionExcludeScore, previousVerdict: s.previous },
      });
    }
    await writeFlagsAndAudit(tx, flags, audits);
  });
  return result;
}

// Relay receipts --------------------------------------------------------------------

export interface VerifyReceiptsOptions {
  /** Wait this long after a receipt's period ends, so the issuance log for it is complete. */
  graceSeconds?: number;
  limit?: number;
}

export interface VerifyReceiptsResult {
  verified: number;
  rejected: number;
  suspendedRelays: string[];
}

/**
 * Check pending receipts against `relay_issuance` for the minutes they cover, then
 * suspend relays whose recent history shows repeated or gross over-reporting.
 */
export async function verifyReceipts(
  db: Database,
  now: Date,
  opts: VerifyReceiptsOptions = {},
): Promise<VerifyReceiptsResult> {
  const thresholds = await loadThresholds(db);
  const tolerance = thresholds.relayOverReportTolerance;
  const cutoff = new Date(now.getTime() - (opts.graceSeconds ?? 120) * 1000);
  const result: VerifyReceiptsResult = { verified: 0, rejected: 0, suspendedRelays: [] };

  await db.transaction(async (tx) => {
    const pending = rows(
      await tx.execute(sql`
        select r.id, r.relay_id, r.period_start, r.period_end, r.bytes_reported,
               (select sum(i.bytes_issued) from relay_issuance i
                 where i.relay_id = r.relay_id and i.bucket_start >= date_trunc('minute', r.period_start)
                   and i.bucket_start < r.period_end) as bytes_issued
          from relay_receipts r
         where r.status = 'pending' and r.period_end <= ${tsz(cutoff)}
         order by r.period_end, r.id
         limit ${opts.limit ?? 1000}
           for update of r skip locked`),
    );
    if (pending.length === 0) return;

    const checks = pending.map((p) => {
      const issued = p.bytes_issued === null ? null : num(p.bytes_issued);
      return { p, issued, check: checkReceipt(num(p.bytes_reported), issued, tolerance) };
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
    for (const { p, issued, check } of checks) {
      if (check.status === "verified") {
        result.verified++;
        continue;
      }
      result.rejected++;
      const details = {
        receiptId: String(p.id),
        reason: check.reason,
        bytesReported: num(p.bytes_reported),
        bytesIssued: issued,
        overReportRatio: check.overReportRatio,
        tolerance,
      };
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
      const history = rows(
        await tx.execute(sql`
          select period_end, status, over_report_ratio from relay_receipts
           where relay_id = ${relayId}::uuid and status in ('verified', 'rejected')
           order by period_end desc limit 5`),
      ).map((h): ReceiptHistoryEntry => ({
        periodEnd: date(h.period_end),
        status: h.status as ReceiptHistoryEntry["status"],
        overReportRatio: h.over_report_ratio === null ? null : Number(h.over_report_ratio),
      }));
      const standing = relayStanding(history, tolerance);
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
      const details = { ...standing, tolerance };
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

/** Exclude low-quality follows that arrived in bursts (`follows.excluded_at`; rows are kept). */
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
               coalesce((select sum(ps.watch_seconds) from playback_sessions ps
                          where ps.user_id = f.follower_id and ps.channel_id = f.channel_id
                            and ps.started_at < f.created_at), 0) as prior_seconds
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
 * Recompute `stream_hours.verified_other_viewers` and `eligible` for recent hours: an hour
 * is eligible when at least one verified session other than the streamer's own overlapped
 * it. The streamer's own sessions are excluded by user id and by every device the
 * streamer has watched from while signed in (so watching your own stream signed out on
 * the same device does not count either).
 */
export async function markEligibleStreamHours(
  db: Database,
  now: Date,
  opts: { lookbackHours?: number } = {},
): Promise<StreamHoursResult> {
  const from = new Date(now.getTime() - (opts.lookbackHours ?? 48) * 3_600_000);
  return db.transaction(async (tx) => {
    const changed = rows(
      await tx.execute(sql`
        with hours as (
          select sh.broadcast_id, sh.hour_start, sh.channel_id, c.owner_id
            from stream_hours sh join channels c on c.id = sh.channel_id
           where sh.hour_start >= ${tsz(from)} and sh.hour_start < ${tsz(now)}
        ),
        owner_devices as (
          select distinct ps.user_id, ps.device_hash from playback_sessions ps
           where ps.user_id in (select owner_id from hours)
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
                              where od.user_id = h.owner_id and od.device_hash = ps.device_hash)
           group by h.broadcast_id, h.hour_start
        )
        update stream_hours sh
           set verified_other_viewers = coalesce(c.n, 0), eligible = coalesce(c.n, 0) >= 1
          from hours h left join counts c on c.broadcast_id = h.broadcast_id and c.hour_start = h.hour_start
         where sh.broadcast_id = h.broadcast_id and sh.hour_start = h.hour_start
           and (sh.verified_other_viewers is distinct from coalesce(c.n, 0)
                or sh.eligible is distinct from (coalesce(c.n, 0) >= 1))
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
          broadcasts: [...new Set(changed.map((r) => String(r.broadcast_id)))],
        },
      });
    }
    return { updated: changed.length, eligible };
  });
}
