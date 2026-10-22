// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live lifecycle: `online`/`offline` events on BUS.live start and stop broadcast sessions, and a
 * periodic reconcile against Postgres (`broadcasts where ended_at is null`) and the MediaMTX
 * path list repairs anything missed (service restarts, dropped pub/sub messages).
 */
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { LiveEvent } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import type { BroadcastInfo, MediaContext } from "./context.ts";
import { isLive } from "./mediamtx.ts";
import { BroadcastSession } from "./session.ts";
import type { LocalLookup } from "./vod/recorder.ts";
import { vodPrefix } from "./vod/recorder.ts";
import { reconcileVods } from "./vod/reconcile.ts";
import { errorCategory } from "./moderation/logging.ts";

/** Consecutive reconciles a session's path may be missing from MediaMTX before it is stopped. */
const MISSING_PATH_TOLERANCE = 2;

export class LiveCoordinator {
  private readonly sessions = new Map<string, BroadcastSession>();
  private readonly missing = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly log;

  constructor(private readonly ctx: MediaContext) {
    this.log = ctx.logger.child({ component: "lifecycle" });
  }

  get liveBroadcasts(): string[] {
    return [...this.sessions.keys()];
  }

  session(broadcastId: string): BroadcastSession | undefined {
    return this.sessions.get(broadcastId);
  }

  liveWindow(broadcastId: string, start: Date, durationSeconds: number): LocalLookup {
    return this.sessions.get(broadcastId)?.liveWindow(start, durationSeconds) ?? null;
  }

  /** Session changes run one at a time so an online racing an offline cannot leak workers. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async handleMessage(raw: string): Promise<void> {
    let event: LiveEvent;
    try {
      event = LiveEvent.parse(JSON.parse(raw));
    } catch {
      this.log.warn("ignoring malformed live event");
      return;
    }
    if (event.type === "online") await this.online(event.broadcastId);
    else if (event.type === "offline") await this.offline(event.broadcastId, true);
    else if (event.type === "simulcast-targets") await this.simulcastTargetsChanged(event.channelId);
  }

  /** A channel's simulcast targets changed: its live session (if any) reconciles its pushes. */
  simulcastTargetsChanged(channelId: string): Promise<void> {
    return this.serial(async () => {
      for (const s of this.sessions.values()) {
        if (s.info.channelId === channelId) await s.reconcileSimulcast();
      }
    });
  }

  online(broadcastId: string): Promise<void> {
    return this.serial(async () => {
      if (this.closed || this.sessions.has(broadcastId)) return;
      const info = await this.loadBroadcast(broadcastId);
      if (!info) {
        this.log.warn("online event for unknown or ended broadcast", { broadcastId });
        return;
      }
      await this.startSession(info);
    });
  }

  /** `finalizeVod` false: the broadcast ended but its VOD must not be published (hash match). */
  offline(broadcastId: string, final: boolean, finalizeVod = final, strict = false): Promise<void> {
    return this.serial(async () => {
      const s = this.sessions.get(broadcastId);
      if (!s) return;
      if (!strict) {
        this.sessions.delete(broadcastId);
        this.missing.delete(broadcastId);
      }
      await s.stop(final, finalizeVod, strict);
      this.sessions.delete(broadcastId);
      this.missing.delete(broadcastId);
    });
  }

  /** Stop everything without finalizing: a restarted service resumes these broadcasts. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.serial(async () => {
      const all = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.all(all.map((s) => s.stop(false)));
    });
  }

  reconcile(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      const rows = await this.liveRows();
      const byId = new Map(rows.map((r) => [r.broadcastId, r]));
      let livePaths: Set<string> | null = null;
      try {
        livePaths = new Set((await this.ctx.mtx.listPaths()).filter(isLive).map((p) => p.name));
      } catch (err) {
        // Without MediaMTX we cannot tell what is live; never stop work on that basis.
        this.log.warn("reconcile: MediaMTX unavailable", { error: errorCategory(err) });
      }

      for (const [id, s] of this.sessions) {
        const row = byId.get(id);
        const pathGone = livePaths !== null && !livePaths.has(s.info.path);
        const misses = pathGone ? (this.missing.get(id) ?? 0) + 1 : 0;
        this.missing.set(id, misses);
        if (!row || row.suspended || misses >= MISSING_PATH_TOLERANCE) {
          this.log.info("reconcile: stopping session", { broadcastId: id, ended: !row, misses });
          this.sessions.delete(id);
          this.missing.delete(id);
          await s.stop(true);
        }
      }
      if (livePaths)
        for (const row of rows)
          if (!this.sessions.has(row.broadcastId) && !row.suspended && livePaths.has(row.path)) {
            this.log.info("reconcile: starting missed session", { broadcastId: row.broadcastId });
            await this.startSession(row);
          }
      await this.finalizeOrphans();
    });
  }

  private async startSession(info: BroadcastInfo & { suspended?: boolean }): Promise<void> {
    if (info.suspended) return;
    // A reconnect of a channel with a T0 match here, before the worker's suspension lands.
    if (this.ctx.moderation.isLiveTainted(info.channelId, info.path)) {
      this.ctx.moderation.refuseReconnect({
        broadcastId: info.broadcastId,
        channelId: info.channelId,
        path: info.path,
      });
      return;
    }
    const vodId = info.vodEnabled ? await this.ensureVod(info) : null;
    const session = new BroadcastSession(this.ctx, info, vodId);
    this.sessions.set(info.broadcastId, session);
    await session.start();
  }

  private async liveRows(): Promise<(BroadcastInfo & { suspended: boolean })[]> {
    return this.selectBroadcasts(isNull(schema.broadcasts.endedAt));
  }

  private async loadBroadcast(broadcastId: string): Promise<(BroadcastInfo & { suspended: boolean }) | null> {
    const [row] = await this.selectBroadcasts(
      and(eq(schema.broadcasts.id, broadcastId), isNull(schema.broadcasts.endedAt)),
    );
    return row ?? null;
  }

  private async selectBroadcasts(where: SQL | undefined) {
    const b = schema.broadcasts;
    const c = schema.channels;
    const rows = await this.ctx.db
      .select({
        broadcastId: b.id,
        channelId: b.channelId,
        slug: c.slug,
        path: b.path,
        title: b.title,
        startedAt: b.startedAt,
        vodEnabled: c.vodEnabled,
        suspendedAt: c.suspendedAt,
      })
      .from(b)
      .innerJoin(c, eq(c.id, b.channelId))
      .where(where);
    return rows.map(({ suspendedAt, ...r }) => ({ ...r, suspended: suspendedAt !== null }));
  }

  /** The VOD row for a broadcast: resume one left `recording` by a previous process, else create. */
  private async ensureVod(info: BroadcastInfo): Promise<string> {
    const v = schema.vods;
    const [existing] = await this.ctx.db
      .select({ id: v.id })
      .from(v)
      .where(and(eq(v.broadcastId, info.broadcastId), eq(v.status, "recording")))
      .limit(1);
    if (existing) return existing.id;
    const id = uuidv7();
    await this.ctx.db.insert(v).values({
      id,
      broadcastId: info.broadcastId,
      channelId: info.channelId,
      title: info.title || info.slug,
      status: "recording",
      storagePrefix: vodPrefix(id),
    });
    return id;
  }

  /**
   * VODs nobody is finishing: `recording` after their broadcast ended while no session ran (we
   * were down), or `processing` with no finalize job left. Runs inside `serial`, so it never
   * races a session that is still flushing its last segments.
   */
  private async finalizeOrphans(): Promise<void> {
    const { db, vodJobs, logger, timings } = this.ctx;
    await reconcileVods(
      { db, jobs: vodJobs, logger, failAfterMs: timings.vodFailAfterMs, retryAfterMs: timings.vodRetryAfterMs },
      new Set(this.sessions.keys()),
    );
  }
}
