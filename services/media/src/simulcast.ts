// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Simulcast: restream the source unchanged (`-c copy`) to each enabled target of the channel.
 * Status lives in `simulcast_sessions` (durable) and `KEYS.simulcastStatus` (live dashboard):
 * connecting → live (ffmpeg reports output) → error (with the last ffmpeg line, key redacted)
 * → connecting again after backoff (capped at 60 s) … → stopped when the broadcast ends.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { SIMULCAST_STATUSES } from "@commonair/contracts/enums";
import { KEYS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { decryptSecret } from "@commonair/tokens";
import type { BroadcastInfo, MediaContext } from "./context.ts";
import { internalRtspUrl, simulcastArgs, simulcastTargetUrl } from "./ffmpeg/args.ts";
import { Supervisor } from "./ffmpeg/supervisor.ts";
import { SIMULCAST_MAX_BACKOFF_MS, SIMULCAST_SECRET_PURPOSE } from "./settings.ts";

export type SimulcastStatus = (typeof SIMULCAST_STATUSES)[number];
const STATUS_TTL_SECONDS = 24 * 3600;

interface Target {
  id: string;
  rtmpUrl: string;
  streamKeyCiphertext: string;
}

class SimulcastRunner {
  private supervisor: Supervisor | null = null;
  private status: SimulcastStatus = "connecting";
  private bytesSent = 0;
  private stopping = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly log;

  constructor(
    private readonly ctx: MediaContext,
    private readonly b: BroadcastInfo,
    private readonly target: Target,
    private readonly sessionId: string,
  ) {
    this.log = ctx.logger.child({ broadcastId: b.broadcastId, simulcastTargetId: target.id, worker: "simulcast" });
  }

  async start(): Promise<void> {
    let key: string;
    try {
      key = await decryptSecret(this.ctx.authSecret, SIMULCAST_SECRET_PURPOSE, this.target.streamKeyCiphertext);
    } catch {
      // Rotating AUTH_SECRET invalidates stored keys; the streamer must re-enter the key.
      await this.setStatus("error", "stream key could not be decrypted; re-enter it in the dashboard");
      return;
    }
    const { rtspBase, internalSecret } = this.ctx;
    const input = internalRtspUrl(rtspBase, this.b.path, internalSecret);
    const output = simulcastTargetUrl(this.target.rtmpUrl, key);
    await this.setStatus("connecting", null);
    this.supervisor = new Supervisor({
      name: `simulcast:${this.target.id}`,
      binary: this.ctx.ffmpeg,
      args: () => simulcastArgs(input, output),
      secrets: [key, internalSecret],
      logger: this.log,
      backoff: { initialMs: 1_000, maxMs: SIMULCAST_MAX_BACKOFF_MS, stableAfterMs: 30_000 },
      onSpawn: () => {
        if (this.status !== "connecting") void this.setStatus("connecting", null);
      },
      onProgress: (p) => {
        if (p.totalSizeBytes !== null) this.bytesSent = Math.max(this.bytesSent, p.totalSizeBytes);
        const flowing = (p.frame !== null && p.frame > 0) || (p.outTimeMs !== null && p.outTimeMs > 0);
        if (flowing && this.status !== "live") void this.setStatus("live", null);
      },
      onExit: (info) => {
        if (this.stopping) return;
        void this.setStatus("error", info.lastError ?? `ffmpeg exited with code ${info.code ?? "unknown"}`);
      },
    });
    this.supervisor.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.supervisor?.stop();
    await this.setStatus("stopped", null, true);
  }

  private setStatus(status: SimulcastStatus, lastError: string | null, ended = false): Promise<void> {
    this.status = status;
    // Serialize writes so a fast connecting→live→error sequence lands in order.
    this.writes = this.writes.then(async () => {
      try {
        const at = new Date();
        await this.ctx.db
          .update(schema.simulcastSessions)
          .set({
            status,
            ...(lastError !== null || status === "live" ? { lastError } : {}),
            bytesSent: this.bytesSent,
            ...(ended ? { endedAt: at } : {}),
          })
          .where(eq(schema.simulcastSessions.id, this.sessionId));
        const key = KEYS.simulcastStatus(this.b.broadcastId);
        await this.ctx.valkey.hset(key, this.target.id, JSON.stringify({ status, lastError, at: at.toISOString() }));
        await this.ctx.valkey.expire(key, STATUS_TTL_SECONDS);
        this.log.info("simulcast status", { status, lastError });
      } catch (err) {
        this.log.warn("could not record simulcast status", { err, status });
      }
    });
    return this.writes;
  }
}

export class SimulcastManager {
  private runners: SimulcastRunner[] = [];

  constructor(
    private readonly ctx: MediaContext,
    private readonly b: BroadcastInfo,
  ) {}

  async start(): Promise<void> {
    const { db } = this.ctx;
    const targets = await db
      .select({
        id: schema.simulcastTargets.id,
        rtmpUrl: schema.simulcastTargets.rtmpUrl,
        streamKeyCiphertext: schema.simulcastTargets.streamKeyCiphertext,
      })
      .from(schema.simulcastTargets)
      .where(and(eq(schema.simulcastTargets.channelId, this.b.channelId), eq(schema.simulcastTargets.enabled, true)));
    for (const t of targets) {
      // On a service restart mid-broadcast, close the session the previous process left open.
      await db
        .update(schema.simulcastSessions)
        .set({ status: "stopped", endedAt: new Date() })
        .where(
          and(
            eq(schema.simulcastSessions.targetId, t.id),
            eq(schema.simulcastSessions.broadcastId, this.b.broadcastId),
            isNull(schema.simulcastSessions.endedAt),
          ),
        );
      const [session] = await db
        .insert(schema.simulcastSessions)
        .values({ targetId: t.id, broadcastId: this.b.broadcastId, status: "connecting" })
        .returning({ id: schema.simulcastSessions.id });
      if (!session) continue;
      const runner = new SimulcastRunner(this.ctx, this.b, t, session.id);
      this.runners.push(runner);
      await runner.start();
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.runners.map((r) => r.stop()));
    this.runners = [];
  }
}
