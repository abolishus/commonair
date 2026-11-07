// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live reconnect grace (overhaul decision 2, F6). When a live publisher goes not-ready the
 * broadcast stays open for `LIVE_RULES.reconnectGraceSeconds`: a publish inside that window
 * continues it (same row, no `stream.offline` / `stream.online`, no second go-live notification,
 * one analytics entry). Past the window the broadcast ends at the moment it dropped, with the usual
 * `stream.offline` and live-bus `offline`.
 *
 * The open grace is a Valkey record per channel plus a sorted set of drop times, so a finalize that
 * an API restart lost is found by `sweepLiveGraces`. The record is read and cleared under the
 * channel row lock (`select … for update`), which serializes a resume against a finalize.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { LIVE_RULES } from "@commonair/contracts/enums";
import { KEYS } from "@commonair/contracts/internal";
import { schema, type Executor } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { broadcasterFields, emit } from "../events/outbox.ts";
import { publishLive } from "../lib/control.ts";

const { channels, broadcasts, playbackSessions } = schema;

const graceKey = (channelId: string) => `media:live-grace:${channelId}`;
/** Channel ids by drop time (ms), for the sweep. */
const DUE_KEY = "media:live-grace:due";
/** The source that published the channel's live broadcast last, so a late not-ready of an older one is ignored. */
export const liveSourceKey = (channelId: string) => `media:live-source:${channelId}`;
/** Far past any grace: the sweep, not this TTL, ends the broadcast. */
export const GRACE_RECORD_TTL_SECONDS = 7 * 86_400;
/** How many expired graces one sweep finalizes. */
const SWEEP_BATCH = 100;

export const LiveGrace = z.object({ broadcastId: z.string(), droppedAt: z.string() });
export type LiveGrace = z.infer<typeof LiveGrace>;

export interface LiveGraceSettings {
  seconds: number;
  /** Runs `finalize` once the grace is over; tests replace it. */
  schedule: (delayMs: number, finalize: () => Promise<void>) => void;
}

const defaultSettings = (deps: Deps): LiveGraceSettings => ({
  seconds: LIVE_RULES.reconnectGraceSeconds,
  schedule: (delayMs, finalize) => {
    const t = setTimeout(() => {
      finalize().catch((err: unknown) => deps.logger.warn("live grace finalize failed", { err: (err as Error).name }));
    }, delayMs);
    t.unref?.();
  },
});

const settings = new WeakMap<Deps, LiveGraceSettings>();

export function liveGraceSettings(deps: Deps): LiveGraceSettings {
  let s = settings.get(deps);
  if (!s) {
    s = defaultSettings(deps);
    settings.set(deps, s);
  }
  return s;
}

/** Tests: a shorter grace, or a scheduler that does nothing (the test finalizes itself). */
export function setLiveGraceSettings(deps: Deps, s: Partial<LiveGraceSettings>): void {
  settings.set(deps, { ...liveGraceSettings(deps), ...s });
}

export const graceDeadline = (g: LiveGrace, seconds: number) => Date.parse(g.droppedAt) + seconds * 1000;

export async function readLiveGrace(deps: Pick<Deps, "valkey">, channelId: string): Promise<LiveGrace | null> {
  const raw = await deps.valkey.get(graceKey(channelId));
  if (!raw) return null;
  try {
    return LiveGrace.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Open the grace for `broadcastId` (call under the channel lock). A duplicate not-ready keeps the
 * first drop time.
 */
export async function openLiveGrace(
  deps: Pick<Deps, "valkey">,
  channelId: string,
  broadcastId: string,
  at: Date,
): Promise<{ grace: LiveGrace; opened: boolean }> {
  const existing = await readLiveGrace(deps, channelId);
  if (existing?.broadcastId === broadcastId) return { grace: existing, opened: false };
  const grace: LiveGrace = { broadcastId, droppedAt: at.toISOString() };
  await deps.valkey
    .multi()
    .set(graceKey(channelId), JSON.stringify(grace), "EX", GRACE_RECORD_TTL_SECONDS)
    .zadd(DUE_KEY, at.getTime(), channelId)
    .exec();
  return { grace, opened: true };
}

/** A resume (under the channel lock): the grace is over and nothing ends the broadcast. */
export async function clearLiveGrace(deps: Pick<Deps, "valkey">, channelId: string): Promise<void> {
  await deps.valkey.multi().del(graceKey(channelId)).zrem(DUE_KEY, channelId).exec();
}

/** Delete the record only if it is still `grace` (after commit: a newer grace must survive). */
const CLEAR_IF_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('del', KEYS[1])
  redis.call('zrem', KEYS[2], ARGV[2])
  return 1
end
if redis.call('exists', KEYS[1]) == 0 then redis.call('zrem', KEYS[2], ARGV[2]) end
return 0`;

export async function clearLiveGraceIf(
  deps: Pick<Deps, "valkey">,
  channelId: string,
  grace: LiveGrace | null,
): Promise<void> {
  await deps.valkey.eval(CLEAR_IF_SCRIPT, 2, graceKey(channelId), DUE_KEY, JSON.stringify(grace), channelId);
}

export interface EndedLive {
  channelId: string;
  broadcastId: string;
  slug: string;
  path: string;
  endedAt: Date;
}

/**
 * End the channel's live broadcast in the transaction (the channel row is locked): the row ends at
 * `endedAt` (the drop, for a grace that ran out), its open playback sessions with it (never before
 * they started), the pointer clears and `stream.offline` is written. Null when it was already over.
 */
export async function endLiveBroadcastInTx(
  tx: Executor,
  c: typeof channels.$inferSelect,
  broadcastId: string,
  endedAt: Date,
  now: Date,
): Promise<EndedLive | null> {
  const [b] = await tx
    .update(broadcasts)
    .set({ endedAt })
    .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.channelId, c.id), isNull(broadcasts.endedAt)))
    .returning();
  if (c.liveBroadcastId) await tx.update(channels).set({ liveBroadcastId: null }).where(eq(channels.id, c.id));
  if (!b) return null;
  await tx
    .update(playbackSessions)
    .set({ endedAt: sql`greatest(${playbackSessions.startedAt}, ${endedAt.toISOString()}::timestamptz)` })
    .where(and(eq(playbackSessions.broadcastId, b.id), isNull(playbackSessions.endedAt)));
  await emit(tx, "stream.offline", c.id, broadcasterFields(c), now);
  return { channelId: c.id, broadcastId: b.id, slug: c.slug, path: b.path, endedAt };
}

/** After commit: clear the live caches and tell media (live bus `offline`). */
export async function announceLiveEnded(deps: Deps, ended: EndedLive): Promise<void> {
  await deps.valkey.del(
    KEYS.viewers(ended.channelId),
    KEYS.viewerCount(ended.channelId),
    KEYS.catchingUpCount(ended.channelId),
    KEYS.renditions(ended.channelId),
    liveSourceKey(ended.channelId),
  );
  await publishLive(deps, {
    type: "offline",
    channelId: ended.channelId,
    broadcastId: ended.broadcastId,
    slug: ended.slug,
    path: ended.path,
    at: ended.endedAt.toISOString(),
  });
}

/**
 * End the channel's broadcast if its grace has run out and nothing resumed or ended it. Returns
 * what ended, or null (no grace, not due yet, resumed, or already ended another way).
 */
export async function finalizeLiveGrace(deps: Deps, channelId: string): Promise<EndedLive | null> {
  const now = deps.now();
  const { seconds } = liveGraceSettings(deps);
  const out = await deps.db.transaction(async (tx) => {
    const [c] = await tx.select().from(channels).where(eq(channels.id, channelId)).for("update");
    // Read under the lock: a resume clears the record under the same lock.
    const grace = await readLiveGrace(deps, channelId);
    if (!grace) return { grace, ended: null, clear: true };
    if (now.getTime() < graceDeadline(grace, seconds)) return { grace, ended: null, clear: false };
    // Ended some other way (a moderation end, a later broadcast): only the record is left.
    if (!c || c.liveBroadcastId !== grace.broadcastId) return { grace, ended: null, clear: true };
    const ended = await endLiveBroadcastInTx(tx, c, grace.broadcastId, new Date(grace.droppedAt), now);
    return { grace, ended, clear: true };
  });
  if (out.clear) await clearLiveGraceIf(deps, channelId, out.grace);
  if (out.ended) {
    await announceLiveEnded(deps, out.ended);
    deps.logger.info("live broadcast ended after reconnect grace", {
      channelId,
      broadcastId: out.ended.broadcastId,
    });
  }
  return out.ended;
}

/** Finalize every grace that has run out (a lost timer, an API restart). Returns how many ended. */
export async function sweepLiveGraces(deps: Deps): Promise<number> {
  const { seconds } = liveGraceSettings(deps);
  const cutoff = deps.now().getTime() - seconds * 1000;
  const due = await deps.valkey.zrangebyscore(DUE_KEY, "-inf", cutoff, "LIMIT", 0, SWEEP_BATCH);
  let n = 0;
  for (const channelId of due) if (await finalizeLiveGrace(deps, channelId)) n++;
  return n;
}

/**
 * Run `sweepLiveGraces` every `intervalMs` (the API's main starts it; one per process is enough,
 * finalizing is idempotent). Returns the stop function.
 */
export function startLiveGraceSweeper(deps: Deps, intervalMs = 10_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepLiveGraces(deps)
      .catch((err: unknown) => deps.logger.warn("live grace sweep failed", { err: (err as Error).name }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
