// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rehearsal driver (W2-rehearsal, batch 6 decisions (f), (g), (h)): one job per arm, enqueued
 * by the outbox relay on `rehearsal.armed` (job id `rehearsal-<armId>`). It waits for the
 * rehearsal broadcast the arm starts, then until it ends:
 *
 * - runs the `@commonair/sim` chat script (~3 msg/s and one 50-message spam burst) through the chat
 *   dry run, which applies the channel's real send pipeline and never posts anything;
 * - reads the ingest health samples the media service writes every 5 s and times the dips;
 * - counts moderation flags on the broadcast (a T0 suspends the channel as live: "safety");
 * - enforces the 30-minute cap per arm, from the arm's first rehearsal (a reconnect does not
 *   restart it): refuse the reconnect, end, `rehearsal.ended`, audit, kick. `capSweepJob` enforces
 *   the same cap on a schedule, so it holds when no driver job has a slot or a job died;
 * - writes `KEYS.rehearsalReport` at least every 5 s.
 *
 * A reconnect inside the arm's TTL (or the session grace) rehearses again under the same arm, so
 * after one broadcast ends the driver waits for the next while the arm is still current. The
 * report carries the driver's own progress (`driver`, stripped by the API), so a restarted job
 * resumes the same report and never re-sends the burst. Nothing here creates a viewer: synthetic
 * senders are presence only, and no playback session or heartbeat is made for them.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { loadEnv } from "@commonair/config";
import { REHEARSAL_RULES } from "@commonair/contracts/enums";
import {
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
  KEYS,
  MEDIA_INTERNAL_USER,
  QUEUES,
  REHEARSAL_JOBS,
  REHEARSAL_REPORT_TTL_SECONDS,
  RehearsalArm,
  RehearsalDriverJob,
  ChatDryRunResult,
} from "@commonair/contracts/internal";
import type { RehearsalReport } from "@commonair/contracts/dto";
import { schema, type Database, type Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import {
  chatScript,
  DEFAULT_BURST,
  DEFAULT_RATE,
  dueMessages,
  emptyTally,
  ingestChecks,
  tally,
  type ChatTally,
  type SimMessage,
} from "@commonair/sim";
import { z } from "zod";
import { audit, emit, endBroadcast, type EndedBroadcast } from "../moderation/records.ts";
import { publishLiveEnded } from "../moderation/t0.ts";
import type { WorkerContext } from "../context.ts";
import { defineJob } from "../runtime/registry.ts";

const { broadcasts, broadcastHealthSamples, channels, events, moderationFlags, playbackSessions, users, wordFilters } =
  schema;

type EndReason = NonNullable<RehearsalReport["endReason"]>;

/** One simulated message through the channel's send pipeline. */
export interface ChatProbe {
  send(channelId: string, senderKey: string, body: string): Promise<ChatDryRunResult>;
}

export interface DriverDeps {
  db: Database;
  valkey: ValkeyClient;
  logger: Logger;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** The chat dry run; null when the worker cannot reach chat (the chat section stays empty). */
  chat: ChatProbe | null;
  /** Disconnect the publisher of a MediaMTX path; false when it could not. */
  kick(path: string): Promise<boolean>;
  /** After an end committed: clear live caches and tell media (BUS.live `offline`). */
  publishEnded(ended: EndedBroadcast, now: Date): Promise<void>;
  /** Loop period (default 1 s), report period (5 s), and the wait-for-publish poll (2 s). */
  tickMs?: number;
  reportEveryMs?: number;
  waitPollMs?: number;
}

/** What the driver keeps in the report to resume (never shown: the API parses it away). */
const DriverState = z.object({
  /** The next script message to send. */
  nextSeq: z.number().int().nonnegative(),
  burstStarted: z.boolean(),
  burstDone: z.boolean(),
  done: z.boolean(),
});
type DriverState = z.infer<typeof DriverState>;
const FRESH: DriverState = { nextSeq: 0, burstStarted: false, burstDone: false, done: false };

/** A message more than this late (the driver was down) is skipped, not sent in a flood. */
const STALE_MESSAGE_MS = 10_000;
/** At most this many messages per tick: a slow chat must not stall the cap check. */
const MAX_SENDS_PER_TICK = 20;
/** The arm's TTL plus slack for a publish that authorized just before it lapsed. */
const WAIT_SLACK_MS = 30_000;

const iso = (d: Date) => d.toISOString();

// ------------------------------------------------------------------ store

interface Stored {
  report: RehearsalReport;
  driver: DriverState;
}

async function loadStored(valkey: ValkeyClient, broadcastId: string): Promise<Stored | null> {
  const raw = await valkey.get(KEYS.rehearsalReport(broadcastId));
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as { driver?: unknown };
    const driver = DriverState.safeParse(json.driver);
    return { report: json as RehearsalReport, driver: driver.success ? driver.data : FRESH };
  } catch {
    return null;
  }
}

async function saveStored(valkey: ValkeyClient, s: Stored): Promise<void> {
  await valkey.set(
    KEYS.rehearsalReport(s.report.broadcastId),
    JSON.stringify({ ...s.report, driver: s.driver }),
    "EX",
    REHEARSAL_REPORT_TTL_SECONDS,
  );
}

function blank(b: { id: string; startedAt: Date }, now: Date): RehearsalReport {
  const t = emptyTally();
  return {
    broadcastId: b.id,
    startedAt: iso(b.startedAt),
    endedAt: null,
    endReason: null,
    chat: { accepted: t.accepted, held: t.held, rejected: t.rejected },
    ingest: [],
    moderation: { samples: 0, flagged: false },
    inviteesWatched: [],
    updatedAt: iso(now),
  };
}

/** A safety end says that and nothing more (feature-wins §4.11). */
function safetyReport(r: RehearsalReport): RehearsalReport {
  const t = emptyTally();
  return {
    ...r,
    chat: { accepted: 0, held: t.held, rejected: t.rejected },
    ingest: [],
    moderation: { samples: 0, flagged: false },
    inviteesWatched: [],
  };
}

// ------------------------------------------------------------------ reads

async function armEvent(db: Database, armId: string): Promise<{ channelId: string; armedAt: Date } | null> {
  const [row] = await db
    .select({ channelId: events.channelId, occurredAt: events.occurredAt })
    .from(events)
    .where(and(eq(events.type, "rehearsal.armed"), sql`${events.payload}->>'arm_id' = ${armId}`))
    .limit(1);
  return row?.channelId ? { channelId: row.channelId, armedAt: row.occurredAt } : null;
}

async function endedEvent(db: Database, armId: string, broadcastId: string | null) {
  const [row] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.type, "rehearsal.ended"),
        sql`${events.payload}->>'arm_id' = ${armId}`,
        broadcastId === null
          ? sql`${events.payload}->>'broadcast_id' is null`
          : sql`${events.payload}->>'broadcast_id' = ${broadcastId}`,
      ),
    )
    .limit(1);
  return row ? (row.payload as { reason: EndReason }) : null;
}

/**
 * The arm's rehearsals: started at or after its arm (a second of clock slack) and before the
 * channel's next arm. A driver whose arm was disarmed and re-armed never picks up the new arm's
 * rehearsal.
 */
interface ArmWindow {
  channelId: string;
  from: Date;
  until: Date | null;
}

async function armWindow(db: Database, channelId: string, armedAt: Date): Promise<ArmWindow> {
  const [next] = await db
    .select({ occurredAt: events.occurredAt })
    .from(events)
    .where(and(eq(events.type, "rehearsal.armed"), eq(events.channelId, channelId), gt(events.occurredAt, armedAt)))
    .orderBy(asc(events.occurredAt))
    .limit(1);
  return { channelId, from: new Date(armedAt.getTime() - 1000), until: next?.occurredAt ?? null };
}

async function armBroadcasts(db: Database, w: ArmWindow) {
  return db
    .select()
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.channelId, w.channelId),
        eq(broadcasts.kind, "rehearsal"),
        gte(broadcasts.startedAt, w.from),
        w.until ? lt(broadcasts.startedAt, w.until) : undefined,
      ),
    )
    .orderBy(asc(broadcasts.startedAt));
}

/** The arm's cap: 30 minutes from its first rehearsal, however often the encoder reconnects. */
export const capAtOf = (firstStartedAt: Date) => firstStartedAt.getTime() + REHEARSAL_RULES.maxDurationSeconds * 1000;

/** When the owner disarmed this arm, if they did (a publish authorized just before may still start one). */
async function disarmedAt(db: Database, armId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.type, "rehearsal.ended"),
        sql`${events.payload}->>'arm_id' = ${armId}`,
        sql`${events.payload}->>'reason' = 'disarmed'`,
      ),
    )
    .limit(1);
  return row?.at ?? null;
}

/** Whether the arm (or the session of a rehearsal it started) is still the channel's current one. */
async function armCurrent(valkey: ValkeyClient, channelId: string, armId: string): Promise<boolean> {
  const [a, s] = await valkey.mget(KEYS.rehearsalArmed(channelId), KEYS.rehearsalSession(channelId));
  return [a, s].some((raw) => {
    if (!raw) return false;
    try {
      return RehearsalArm.parse(JSON.parse(raw)).armId === armId;
    } catch {
      return false;
    }
  });
}

/** The arm's next rehearsal to drive (open, or ended without a final report: a resumed job) and its cap. */
async function nextBroadcast(deps: DriverDeps, w: ArmWindow) {
  const rows = await armBroadcasts(deps.db, w);
  const first = rows[0];
  if (!first) return null;
  for (const b of rows) {
    const stored = await loadStored(deps.valkey, b.id);
    if (!stored?.driver.done) return { broadcast: b, capAt: capAtOf(first.startedAt) };
  }
  return null;
}

async function filterWords(db: Database, channelId: string): Promise<string[]> {
  const rows = await db
    .select({ pattern: wordFilters.pattern })
    .from(wordFilters)
    .where(
      and(eq(wordFilters.channelId, channelId), eq(wordFilters.isRegex, false), ne(wordFilters.action, "replace")),
    );
  return rows.map((r) => r.pattern);
}

async function healthOf(db: Database, broadcastId: string) {
  const rows = await db
    .select()
    .from(broadcastHealthSamples)
    .where(eq(broadcastHealthSamples.broadcastId, broadcastId))
    .orderBy(asc(broadcastHealthSamples.at));
  return ingestChecks(
    rows.map((r) => ({
      atMs: r.at.getTime(),
      bitrateKbps: r.bitrateKbps,
      fps: r.fps,
      keyframeIntervalMs: r.keyframeIntervalMs,
      droppedFrames: r.droppedFrames,
      warnings: r.warnings,
    })),
  ).map((c) => ({
    check: c.check,
    ok: c.ok,
    dips: c.dips.map((d) => ({ at: iso(new Date(d.atMs)), seconds: d.seconds })),
  }));
}

async function flagged(db: Database, broadcastId: string): Promise<boolean> {
  const [f] = await db
    .select({ id: moderationFlags.id })
    .from(moderationFlags)
    .where(
      and(
        eq(moderationFlags.subjectType, "broadcast"),
        eq(moderationFlags.subjectId, broadcastId),
        inArray(moderationFlags.tier, ["t1", "t2"]),
      ),
    )
    .limit(1);
  return f !== undefined;
}

async function watched(db: Database, broadcastId: string, ownerId: string) {
  return db
    .selectDistinct({ id: users.id, username: users.username })
    .from(playbackSessions)
    .innerJoin(users, eq(users.id, playbackSessions.userId))
    .where(
      and(eq(playbackSessions.broadcastId, broadcastId), isNotNull(playbackSessions.userId), ne(users.id, ownerId)),
    )
    .orderBy(asc(users.username));
}

// ------------------------------------------------------------------ ends

/** `rehearsal.ended` once per (arm, broadcast): serialized so a retried job never doubles it. */
async function emitEnded(
  tx: Executor,
  channelId: string,
  armId: string,
  broadcastId: string | null,
  reason: EndReason,
  now: Date,
): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rehearsal-ended:${armId}:${broadcastId ?? "-"}`}))`);
  const [existing] = await tx
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, "rehearsal.ended"),
        sql`${events.payload}->>'arm_id' = ${armId}`,
        broadcastId === null
          ? sql`${events.payload}->>'broadcast_id' is null`
          : sql`${events.payload}->>'broadcast_id' = ${broadcastId}`,
      ),
    )
    .limit(1);
  if (existing) return false;
  await emit(
    tx,
    "rehearsal.ended",
    channelId,
    { channel_id: channelId, arm_id: armId, broadcast_id: broadcastId, reason },
    now,
  );
  return true;
}

type ForcedEnd = "cap" | "disarmed";

/**
 * The cap, or a rehearsal that started after its arm was disarmed (a publish authorized just
 * before the disarm): refuse the reconnect, clear the arm, end, event and audit, then kick.
 */
export async function forceEnd(
  deps: Pick<DriverDeps, "db" | "valkey" | "logger" | "now" | "kick" | "publishEnded">,
  armId: string,
  b: { id: string; channelId: string },
  reason: ForcedEnd,
): Promise<boolean> {
  const now = deps.now();
  // Before the kick (decision (f)): the encoder's automatic reconnect neither rehearses nor goes live.
  await deps.valkey.set(KEYS.rehearsalKicked(b.channelId), "1", "EX", REHEARSAL_RULES.kickCooldownSeconds);
  if (await armCurrent(deps.valkey, b.channelId, armId))
    await deps.valkey.del(KEYS.rehearsalArmed(b.channelId), KEYS.rehearsalSession(b.channelId));
  const ended = await deps.db.transaction(async (tx) => {
    const e = await endBroadcast(tx, b.id, now);
    if (!e) return null; // ended meanwhile (publisher, disarm): that end stands
    await emitEnded(tx, b.channelId, armId, b.id, reason, now);
    await audit(
      tx,
      {
        action: reason === "cap" ? "rehearsal.cap" : "rehearsal.disarm",
        subjectType: "broadcast",
        subjectId: b.id,
        channelId: b.channelId,
        details:
          reason === "cap"
            ? { armId, maxDurationSeconds: REHEARSAL_RULES.maxDurationSeconds }
            : { armId, broadcastId: b.id, startedAfterDisarm: true },
      },
      now,
    );
    return e;
  });
  if (!ended) return false;
  await deps.publishEnded(ended, now);
  const kicked = await deps.kick(ended.path).catch(() => false);
  if (!kicked) deps.logger.warn("rehearsal end: publisher kick failed", { broadcastId: b.id, reason });
  return true;
}

/** Why a rehearsal the driver did not end ended: disarm's event, a suspension (T0), or the encoder. */
async function endReasonOf(deps: DriverDeps, armId: string, b: { id: string; channelId: string }): Promise<EndReason> {
  const ev = await endedEvent(deps.db, armId, b.id);
  if (ev) return ev.reason;
  const [c] = await deps.db
    .select({ suspendedAt: channels.suspendedAt })
    .from(channels)
    .where(eq(channels.id, b.channelId));
  return c?.suspendedAt ? "safety" : "publisher_ended";
}

// ------------------------------------------------------------------ the loop

export interface DriverResult {
  broadcasts: number;
  sent: number;
  ended: number;
  expired: number;
}

async function driveBroadcast(
  deps: DriverDeps,
  armId: string,
  b: typeof schema.broadcasts.$inferSelect,
  ownerId: string,
  capAt: number,
): Promise<{ sent: number }> {
  const tickMs = deps.tickMs ?? 1000;
  const reportEveryMs = deps.reportEveryMs ?? 5000;
  const stored = (await loadStored(deps.valkey, b.id)) ?? { report: blank(b, deps.now()), driver: FRESH };
  let { report, driver } = stored;
  // Resuming mid-burst: what was not sent is dropped, never re-sent.
  if (driver.burstStarted && !driver.burstDone) driver = { ...driver, burstDone: true };
  let chat: ChatTally = { accepted: report.chat.accepted, held: report.chat.held, rejected: report.chat.rejected };
  const script: SimMessage[] = chatScript({
    seed: b.id,
    rate: DEFAULT_RATE,
    burst: DEFAULT_BURST,
    filterWords: await filterWords(deps.db, b.channelId),
  });
  const lastBurstSeq = script.reduce((n, m) => (m.burst ? m.seq : n), -1);
  let sent = 0;
  let lastReport = 0;

  const refresh = async (now: Date) => {
    report = {
      ...report,
      chat,
      ingest: await healthOf(deps.db, b.id),
      moderation: { samples: report.moderation.samples, flagged: await flagged(deps.db, b.id) },
      inviteesWatched: await watched(deps.db, b.id, ownerId),
      updatedAt: iso(now),
    };
  };
  const save = () => saveStored(deps.valkey, { report, driver });

  for (;;) {
    const now = deps.now();
    const [row] = await deps.db.select({ endedAt: broadcasts.endedAt }).from(broadcasts).where(eq(broadcasts.id, b.id));
    let reason: EndReason | null = null;
    if (!row?.endedAt && now.getTime() >= capAt) {
      await forceEnd(deps, armId, b, "cap");
      reason = await endReasonOf(deps, armId, b);
    } else if (!row?.endedAt && (await disarmedAt(deps.db, armId)) !== null) {
      await forceEnd(deps, armId, b, "disarmed");
      reason = await endReasonOf(deps, armId, b);
    } else if (row?.endedAt) {
      reason = await endReasonOf(deps, armId, b);
      if (reason === "publisher_ended" || reason === "safety")
        await deps.db.transaction((tx) => emitEnded(tx, b.channelId, armId, b.id, reason as EndReason, now));
    }
    if (reason !== null) {
      const [ended] = await deps.db
        .select({ endedAt: broadcasts.endedAt })
        .from(broadcasts)
        .where(eq(broadcasts.id, b.id));
      await refresh(now);
      report = { ...report, endedAt: iso(ended?.endedAt ?? now), endReason: reason };
      if (reason === "safety") report = safetyReport(report);
      driver = { ...driver, done: true };
      await save();
      return { sent };
    }

    if (deps.chat) {
      const elapsed = now.getTime() - b.startedAt.getTime();
      // Only sends count against the budget: a resumed driver skips its backlog in one tick.
      let budget = MAX_SENDS_PER_TICK;
      for (const m of dueMessages(script, driver.nextSeq, elapsed)) {
        const skip = elapsed - m.atMs > STALE_MESSAGE_MS || (m.burst && driver.burstDone);
        if (!skip) {
          if (budget-- <= 0) break;
          if (m.burst && !driver.burstStarted) {
            // Recorded before the first burst message leaves, so a restart cannot send it twice.
            driver = { ...driver, burstStarted: true };
            await save();
          }
          try {
            const r = await deps.chat.send(b.channelId, m.senderKey, m.body);
            chat = tally(chat, r.outcome, r.code, m.kind);
            sent++;
          } catch (err) {
            deps.logger.warn("rehearsal chat dry run failed", { broadcastId: b.id, err: (err as Error).name });
            break; // retried next tick
          }
        }
        driver = { ...driver, nextSeq: m.seq + 1 };
        if (m.seq >= lastBurstSeq && driver.burstStarted) driver = { ...driver, burstDone: true };
      }
    }

    if (now.getTime() - lastReport >= reportEveryMs) {
      await refresh(now);
      lastReport = now.getTime();
    } else report = { ...report, chat, updatedAt: iso(now) };
    await save();
    await deps.sleep(tickMs);
  }
}

/** Drive every rehearsal the arm starts, then stop when the arm is no longer current. */
export async function driveRehearsal(deps: DriverDeps, job: RehearsalDriverJob): Promise<DriverResult> {
  const result: DriverResult = { broadcasts: 0, sent: 0, ended: 0, expired: 0 };
  const arm = await armEvent(deps.db, job.armId);
  if (!arm || arm.channelId !== job.channelId) return result;
  const [c] = await deps.db.select({ ownerId: channels.ownerId }).from(channels).where(eq(channels.id, job.channelId));
  if (!c) return result;
  const pollMs = deps.waitPollMs ?? 2000;
  const waitUntil = arm.armedAt.getTime() + REHEARSAL_RULES.armTtlSeconds * 1000 + WAIT_SLACK_MS;
  for (;;) {
    // Re-read each round: a later arm closes this one's window.
    const w = await armWindow(deps.db, job.channelId, arm.armedAt);
    const next = await nextBroadcast(deps, w);
    if (next) {
      const r = await driveBroadcast(deps, job.armId, next.broadcast, c.ownerId, next.capAt);
      result.broadcasts++;
      result.sent += r.sent;
      result.ended++;
      continue;
    }
    if (await armCurrent(deps.valkey, job.channelId, job.armId)) {
      await deps.sleep(pollMs);
      continue;
    }
    // The arm lapsed (or was disarmed). A publish authorized just before the lapse may still be
    // arriving, so an arm that never started a rehearsal gets a little slack.
    const started = (await armBroadcasts(deps.db, w)).length > 0;
    if (!started && deps.now().getTime() < waitUntil) {
      // Disarmed before any publish: wait out a publish authorized just before the disarm (its
      // rehearsal is ended at once above), then stop.
      const off = await disarmedAt(deps.db, job.armId);
      if (off && deps.now().getTime() >= off.getTime() + WAIT_SLACK_MS) return result;
      await deps.sleep(pollMs);
      continue;
    }
    if (!started) {
      const now = deps.now();
      const emitted = await deps.db.transaction((tx) => emitEnded(tx, job.channelId, job.armId, null, "expired", now));
      if (emitted) result.expired++;
    }
    return result;
  }
}

// ------------------------------------------------------------------ the sweep

/** The arm a rehearsal ran under: the channel's last arm at or before it started (clock slack as above). */
async function armOf(db: Database, b: { channelId: string; startedAt: Date }) {
  const [row] = await db
    .select({ payload: events.payload, occurredAt: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.type, "rehearsal.armed"),
        eq(events.channelId, b.channelId),
        lte(events.occurredAt, new Date(b.startedAt.getTime() + 1000)),
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(1);
  const armId = (row?.payload as { arm_id?: unknown } | undefined)?.arm_id;
  return row && typeof armId === "string" ? { armId, armedAt: row.occurredAt } : null;
}

/**
 * Every open rehearsal past its arm's cap, or started after its arm was disarmed, is ended here
 * too. The driver does the same each second, but only while its job holds a queue slot: this
 * holds the cap when the rehearsal queue is full or a driver job died (stalled, failed).
 */
export async function sweepRehearsals(
  deps: Pick<DriverDeps, "db" | "valkey" | "logger" | "now" | "kick" | "publishEnded">,
): Promise<{ capped: number; disarmed: number }> {
  const out = { capped: 0, disarmed: 0 };
  const open = await deps.db
    .select({ id: broadcasts.id, channelId: broadcasts.channelId, startedAt: broadcasts.startedAt })
    .from(broadcasts)
    .where(and(eq(broadcasts.kind, "rehearsal"), isNull(broadcasts.endedAt)));
  for (const b of open) {
    const arm = await armOf(deps.db, b);
    // No arm event cannot happen through the gate; cap it from its own start, under its own id.
    const armId = arm?.armId ?? b.id;
    const first = arm ? (await armBroadcasts(deps.db, await armWindow(deps.db, b.channelId, arm.armedAt)))[0] : b;
    if (deps.now().getTime() >= capAtOf((first ?? b).startedAt)) {
      if (await forceEnd(deps, armId, b, "cap")) out.capped++;
    } else if (arm && (await disarmedAt(deps.db, arm.armId)) !== null) {
      if (await forceEnd(deps, armId, b, "disarmed")) out.disarmed++;
    }
  }
  return out;
}

// ------------------------------------------------------------------ wiring

const rehearsalEnv = z.object({
  INTERNAL_API_SECRET: z.string().min(1).optional(),
  CHAT_INTERNAL_URL: z.string().default("ws://localhost:3002/ws"),
  MEDIAMTX_API_URL: z.url().default("http://localhost:9997"),
  MEDIA_INTERNAL_PASSWORD: z.string().min(1).optional(),
});

/** The chat service's HTTP base from its WebSocket URL (`ws://chat:3002/ws` → `http://chat:3002`). */
export function chatHttpBase(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  return `${u.protocol}//${u.host}`;
}

/** The chat dry run over HTTP (`INTERNAL_ROUTES.chatDryRun`, internal secret). */
export function httpChatProbe(opts: { baseUrl: string; secret: string; fetch?: typeof fetch }): ChatProbe {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send(channelId, senderKey, body) {
      const res = await doFetch(`${opts.baseUrl}${INTERNAL_ROUTES.chatDryRun}`, {
        method: "POST",
        headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: opts.secret },
        body: JSON.stringify({ channelId, senderKey, body }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`chat dry run answered ${res.status}`);
      }
      return ChatDryRunResult.parse(await res.json());
    },
  };
}

const KICK_ROUTES: Readonly<Record<string, string>> = {
  rtmpConn: "rtmpconns",
  rtmpsConn: "rtmpsconns",
  webRTCSession: "webrtcsessions",
  rtspSession: "rtspsessions",
  rtspsSession: "rtspssessions",
  srtConn: "srtconns",
};

/** Disconnect whoever publishes `path` (MediaMTX control API, internal credentials), as the API does. */
export function mediamtxKick(opts: { apiUrl: string; password: string; fetch?: typeof fetch }) {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const headers = {
    authorization: `Basic ${Buffer.from(`${MEDIA_INTERNAL_USER}:${opts.password}`).toString("base64")}`,
  };
  return async (path: string): Promise<boolean> => {
    const res = await doFetch(`${base}/v3/paths/get/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    const p = (await res.json()) as { source?: { type?: string; id?: string } | null };
    const route = p.source?.type ? KICK_ROUTES[p.source.type] : undefined;
    if (!route || !p.source?.id) return false;
    const kick = await doFetch(`${base}/v3/${route}/kick/${encodeURIComponent(p.source.id)}`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    await kick.body?.cancel();
    return kick.ok;
  };
}

interface RehearsalConfig {
  chat: { baseUrl: string; secret: string } | null;
  kick: { apiUrl: string; password: string } | null;
}
let cached: RehearsalConfig | undefined;

/**
 * Read once per process. `workerEnv` already requires the internal secret; it does not carry the
 * chat URL or the media credentials yet (contract request), so a worker without the media password
 * ends a capped rehearsal without the kick, and says so in its log.
 */
export function rehearsalConfig(source?: Record<string, string | undefined>): RehearsalConfig {
  if (!source && cached) return cached;
  const env = loadEnv(rehearsalEnv, source ?? process.env);
  const cfg: RehearsalConfig = {
    chat: env.INTERNAL_API_SECRET
      ? { baseUrl: chatHttpBase(env.CHAT_INTERNAL_URL), secret: env.INTERNAL_API_SECRET }
      : null,
    kick: env.MEDIA_INTERNAL_PASSWORD ? { apiUrl: env.MEDIAMTX_API_URL, password: env.MEDIA_INTERNAL_PASSWORD } : null,
  };
  if (!source) cached = cfg;
  return cfg;
}

function endDeps(ctx: WorkerContext, cfg: RehearsalConfig) {
  return {
    db: ctx.db,
    valkey: ctx.valkey,
    logger: ctx.logger,
    now: () => ctx.now(),
    kick: cfg.kick ? mediamtxKick(cfg.kick) : async () => false,
    publishEnded: (ended: EndedBroadcast, now: Date) => publishLiveEnded(ctx, ended, now),
  };
}

export const job = defineJob({
  queue: QUEUES.rehearsal,
  name: REHEARSAL_JOBS.driver,
  description: "Drive an armed rehearsal: simulated chat, ingest checks, the duration cap and the report",
  data: RehearsalDriverJob,
  handler: async (data, ctx): Promise<Record<string, number>> => {
    const cfg = rehearsalConfig();
    if (!cfg.chat)
      ctx.logger.warn("rehearsal driver: no internal secret, simulated chat skipped", { armId: data.armId });
    const result = await driveRehearsal(
      {
        ...endDeps(ctx, cfg),
        sleep: (ms) => Bun.sleep(ms),
        chat: cfg.chat ? httpChatProbe(cfg.chat) : null,
      },
      data,
    );
    return { ...result };
  },
});

/**
 * The cap without the driver (`sweepRehearsals`). Not on the rehearsal queue, whose slots the
 * long driver jobs hold. Registered in `jobs/index.ts` by the orchestrator (contract request).
 */
export const capSweepJob = defineJob({
  queue: QUEUES.integrity,
  name: "rehearsal-cap-sweep",
  description: "End rehearsals past their arm's 30-minute cap, or started after a disarm",
  data: z.object({}),
  schedule: { every: 30_000 },
  handler: async (_data, ctx) => sweepRehearsals(endDeps(ctx, rehearsalConfig())),
});
