// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Surge raids (batch 7 decision (w), ADR 0039 §4): a raid into a channel with the surge guard on and
 * "Protect raids" (`surgeGuard.onRaid`) opens surge mode (`trigger: "raid"`) for
 * `RAID_RULES.surgeMinutes`, or extends the open one (never shortens it); a moderator's
 * `suppressed` override still wins. Raiders who were verified watchers of the source in the last
 * `RAID_RULES.carryMinutes` carry that standing to the target for the surge: a TTL'd
 * `KEYS.verifiedWatch` merge-write (`VERIFIED_WATCH_MERGE`), so chat is unchanged.
 *
 * `decideRaidSurge` is pure. `applyRaidSurge` runs inside the raid's transaction (a savepoint):
 * the outbox and audit rows first, the override compare-and-set last, so a moderator's change in
 * between rolls the surge back and the caller decides again. `carryRaiders` runs after the commit.
 *
 * The carry lasts the surge as the raid leaves it. A later guard extension (surge.ts) does not
 * lengthen it: by then raiders have had the raid's surge to build their own standing on the target,
 * and the scoring pass's keys take over, as for anyone else.
 */
import { sql } from "drizzle-orm";
import { KEYS, type SurgeOverride, VerifiedWatchValue } from "@commonair/contracts/internal";
import type { Executor } from "@commonair/db";
import { GATE_ELIGIBLE, loadThresholds } from "@commonair/integrity";
import {
  type CarryValue,
  carryWindowStart,
  inCarryWindow,
  raidCarryTtlSeconds,
  raidCarryValue,
  raidSurgeUntil,
  type SurgeRaidInfo,
} from "@commonair/interact";
import type { WorkerContext } from "../context.ts";
import { verifiedWatchMergeArgs } from "../integrity/verified-watch.ts";
import { audit, emit } from "../moderation/records.ts";
import { overrideTtlSeconds } from "./hysteresis.ts";
import { casOverride, type StoredOverride } from "./state.ts";
import { PRIVACY_RELAY_PREFIX, unlocks, type WatchRow } from "./unlocks.ts";

/** A `KEYS.surgeOverride` value with the raid it holds chat for (read back with `surgeRaidOf`). */
export type RaidSurgeOverride = SurgeOverride & { raid?: SurgeRaidInfo };

export type RaidSurgeAction =
  /** A begin was recorded and the key lapsed without its end: record the end first (as the guard does). */
  | { kind: "expired" }
  | { kind: "begin"; next: RaidSurgeOverride }
  /** Surge mode is already on: the later `until` wins, and the banner names this raid. */
  | { kind: "extend"; next: RaidSurgeOverride };

export interface RaidSurgeInput {
  now: Date;
  /** The override as stored (`readOverride(…).value`). */
  current: SurgeOverride | null;
  /** The guard's begin-without-end marker (`KEYS.surgeOpen`). */
  open: boolean;
  raid: SurgeRaidInfo;
}

/** What a raid does to the target's surge state, in order; empty while a moderator's suppression runs. */
export function decideRaidSurge(i: RaidSurgeInput): RaidSurgeAction[] {
  const now = i.now.getTime();
  const until = raidSurgeUntil(i.now).toISOString();
  const begin: RaidSurgeAction = {
    kind: "begin",
    next: { state: "on", since: i.now.toISOString(), until, by: null, raid: i.raid },
  };
  const c = i.current;
  if (!c) return i.open ? [{ kind: "expired" }, begin] : [begin];
  // A moderator's end wins until it runs out (ADR 0015 decision 6), raids included.
  if (c.state === "suppressed") return now >= Date.parse(c.until) ? [begin] : [];
  // `since` (the chatted-before exemption) and `by` stay; the surge never gets shorter.
  const later = Date.parse(until) > Date.parse(c.until) ? until : c.until;
  return [{ kind: "extend", next: { ...c, until: later, raid: i.raid } }];
}

/** The override after the actions, or null when they leave it alone. */
export const raidSurgeResult = (actions: readonly RaidSurgeAction[]): RaidSurgeOverride | null => {
  const last = actions.at(-1);
  return last && last.kind !== "expired" ? last.next : null;
};

/** The override changed between the read and the compare-and-set (a moderator acted). */
export class RaidSurgeConflict extends Error {
  constructor() {
    super("surge override changed during a raid");
    this.name = "RaidSurgeConflict";
  }
}

export interface RaidSurgeContext {
  raidId: string;
  targetId: string;
  sourceId: string;
  now: Date;
}

/**
 * Record the actions in `tx` and write the override last (compare-and-set against `current.raw`).
 * Throws `RaidSurgeConflict` when the key changed since it was read; the caller's savepoint rolls
 * the rows back. Returns the override now stored, or null when nothing changed.
 */
export async function applyRaidSurge(
  tx: Executor,
  valkey: WorkerContext["valkey"],
  current: StoredOverride,
  actions: readonly RaidSurgeAction[],
  c: RaidSurgeContext,
): Promise<RaidSurgeOverride | null> {
  const next = raidSurgeResult(actions);
  if (!next) return null;
  for (const a of actions) {
    switch (a.kind) {
      case "expired":
        await emit(tx, "chat.surge.end", c.targetId, { reason: "expired", by_user_id: null }, c.now);
        await audit(tx, surgeAudit(c.targetId, "chat.surge.end", { reason: "expired" }), c.now);
        break;
      case "begin":
        await emit(
          tx,
          "chat.surge.begin",
          c.targetId,
          { trigger: "raid", until: a.next.until, by_user_id: null },
          c.now,
        );
        await audit(tx, surgeAudit(c.targetId, "chat.surge.begin", raidDetails(a.next, c)), c.now);
        break;
      case "extend": {
        // No begin (surge mode was already on); the audit row ties the surge to the raid, and says
        // whether it got longer (a raid into a longer surge only moves the banner).
        const extended = a.next.until !== current.value?.until;
        await audit(tx, surgeAudit(c.targetId, "chat.surge.extend", { ...raidDetails(a.next, c), extended }), c.now);
        break;
      }
    }
  }
  // Last: a moderator's change in between wins and rolls this back.
  if (!(await casOverride(valkey, c.targetId, current.raw, next, overrideTtlSeconds(next, c.now))))
    throw new RaidSurgeConflict();
  return next;
}

function raidDetails(next: RaidSurgeOverride, c: RaidSurgeContext): Record<string, string | number> {
  // Ids and counts only (no personal data in audit details).
  return {
    trigger: "raid",
    raidId: c.raidId,
    fromChannelId: c.sourceId,
    verifiedCount: next.raid?.verifiedCount ?? 0,
    until: next.until,
  };
}

function surgeAudit(channelId: string, action: string, details: Record<string, string | number | boolean>) {
  return { action, subjectType: "channel", subjectId: channelId, channelId, details };
}

// ------------------------------------------------------------ the carry

type Row = Record<string, unknown>;

export interface CarryInput {
  sourceId: string;
  sourceBroadcastId: string;
  targetId: string;
  targetBroadcastId: string;
  /** When the surge ends: the carry lasts until then (plus the override's grace). */
  surgeUntil: Date;
  now: Date;
  /** The verified-watch jitter key (`INTERNAL_API_SECRET`), for the source values worked out here. */
  secret: string;
}

/** One signed-in viewer's watching of the source broadcast from one address. */
export interface SourceWatch extends WatchRow {
  /** Some of these sessions are gate-eligible (only those count toward `seconds`). */
  eligible: boolean;
  /** The latest heartbeat (or start) of any of these sessions. */
  lastSeenAt: Date;
  /** The latest heartbeat (or start) of the gate-eligible ones; null when none is. */
  lastEligibleAt: Date | null;
}

/**
 * Who carries, with their source value: verified watchers of the source's live broadcast within
 * `RAID_RULES.carryMinutes`. Either a current source `KEYS.verifiedWatch` value (`stored`: its 600 s
 * TTL already means "verified in the last 10 minutes"; the raider must still be seen there in the
 * window), or the scoring pass's own rule worked out now (`unlocks`: gate-eligible sessions under the
 * per-address cap) for a raider with a gate-eligible session in the window, so a source without the
 * gate or the guard (no keys written) still carries its real audience, and someone verified hours
 * ago who is now only an unverified session does not. Rows must already exclude the exempt roles. Pure.
 */
export function carriedSources(
  rows: readonly SourceWatch[],
  stored: ReadonlyMap<string, VerifiedWatchValue>,
  sourceBroadcastId: string,
  now: Date,
  perAddress: number,
  secret: string,
): Map<string, CarryValue> {
  const seen = new Set<string>();
  const seenVerified = new Set<string>();
  for (const r of rows) {
    if (inCarryWindow(r.lastSeenAt, now)) seen.add(r.userId);
    if (r.lastEligibleAt && inCarryWindow(r.lastEligibleAt, now)) seenVerified.add(r.userId);
  }
  const out = new Map<string, CarryValue>();
  for (const u of unlocks(
    rows.filter((r) => r.eligible),
    perAddress,
    secret,
  ))
    if (seenVerified.has(u.userId) && u.value.b === sourceBroadcastId) out.set(u.userId, u.value);
  for (const [userId, v] of stored)
    if (seen.has(userId) && v.b === sourceBroadcastId && !out.has(userId)) out.set(userId, v);
  return out;
}

/**
 * The source broadcast's signed-in watching, per (user, address), for `carriedSources`. Leaves out
 * whom the scoring pass leaves out (integrity/verified-watch.ts `writeVerifiedWatch`): the owner,
 * verified bots, the source's moderators and VIPs, so they neither carry nor take a place in the cap.
 */
export async function sourceWatching(db: Executor, sourceId: string, broadcastId: string): Promise<SourceWatch[]> {
  const rows = (await db.execute(sql`
    select ps.user_id, ps.ip_hash,
           coalesce(ps.datacenter like ${`${PRIVACY_RELAY_PREFIX}%`}, false) as relay,
           bool_or(${GATE_ELIGIBLE}) as eligible,
           coalesce(sum(ps.watch_seconds) filter (where ${GATE_ELIGIBLE}), 0)::int as seconds,
           coalesce(min(ps.started_at) filter (where ${GATE_ELIGIBLE}), min(ps.started_at)) as first_at,
           max(coalesce(ps.last_heartbeat_at, ps.started_at)) as last_seen,
           max(coalesce(ps.last_heartbeat_at, ps.started_at)) filter (where ${GATE_ELIGIBLE}) as last_eligible
      from channels c
      join playback_sessions ps on ps.channel_id = c.id
      join users u on u.id = ps.user_id
     where c.id = ${sourceId}::uuid and ps.broadcast_id = ${broadcastId}::uuid
       and ps.user_id <> c.owner_id
       and not (u.account_type = 'bot' and u.bot_verified)
       and not exists (select 1 from channel_roles r
                        where r.channel_id = c.id and r.user_id = ps.user_id and r.role in ('moderator', 'vip'))
     group by ps.user_id, ps.ip_hash, relay`)) as unknown as Row[];
  const date = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
  return rows.map((r) => ({
    channelId: sourceId,
    broadcastId,
    userId: String(r.user_id),
    ipHash: String(r.ip_hash),
    privacyRelay: r.relay === true,
    seconds: Number(r.seconds ?? 0),
    firstAt: date(r.first_at),
    eligible: r.eligible === true,
    lastSeenAt: date(r.last_seen),
    lastEligibleAt: r.last_eligible === null || r.last_eligible === undefined ? null : date(r.last_eligible),
  }));
}

/** The source's stored `KEYS.verifiedWatch` values for `userIds` (malformed and absent ones left out). */
async function storedSourceValues(
  valkey: WorkerContext["valkey"],
  sourceId: string,
  userIds: readonly string[],
): Promise<Map<string, VerifiedWatchValue>> {
  const out = new Map<string, VerifiedWatchValue>();
  // MGET in slices: a big raid is a few round trips, never one huge reply.
  for (let i = 0; i < userIds.length; i += 500) {
    const ids = userIds.slice(i, i + 500);
    const raws = await valkey.mget(...ids.map((u) => KEYS.verifiedWatch(sourceId, u)));
    ids.forEach((u, j) => {
      const raw = raws[j];
      if (raw === null || raw === undefined) return;
      try {
        const parsed = VerifiedWatchValue.safeParse(JSON.parse(raw));
        if (parsed.success) out.set(u, parsed.data);
      } catch {
        // Unreadable: as chat, treat it as absent.
      }
    });
  }
  return out;
}

/**
 * Write the carry: one `VERIFIED_WATCH_MERGE` per carried raider on the target, so a scoring pass
 * never shortens or lowers it and it never lowers a larger target value. Returns the count.
 */
export async function carryRaiders(ctx: Pick<WorkerContext, "db" | "valkey">, c: CarryInput): Promise<number> {
  const rows = await sourceWatching(ctx.db, c.sourceId, c.sourceBroadcastId);
  const since = carryWindowStart(c.now);
  const candidates = [...new Set(rows.filter((r) => r.lastSeenAt >= since).map((r) => r.userId))];
  if (candidates.length === 0) return 0;
  const [stored, thresholds] = await Promise.all([
    storedSourceValues(ctx.valkey, c.sourceId, candidates),
    loadThresholds(ctx.db),
  ]);
  const sources = carriedSources(rows, stored, c.sourceBroadcastId, c.now, thresholds.gateUnlocksPerAddress, c.secret);
  const ttl = raidCarryTtlSeconds(c.surgeUntil, c.now);
  const pipe = ctx.valkey.pipeline();
  let n = 0;
  for (const [userId, source] of sources) {
    const value = raidCarryValue(source, c.sourceBroadcastId, c.targetBroadcastId);
    if (!value) continue;
    pipe.eval(...verifiedWatchMergeArgs(c.targetId, userId, value, ttl));
    n++;
  }
  if (n === 0) return 0;
  const results = await pipe.exec();
  const failed = (results ?? []).find(([err]) => err);
  if (failed?.[0]) throw failed[0];
  return n;
}
