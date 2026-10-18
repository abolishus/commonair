// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Simulcast: restream the source unchanged (`-c copy`) to each enabled target of the channel.
 * Status lives in `simulcast_sessions` (durable) and `KEYS.simulcastStatus` (live dashboard):
 * connecting → live (ffmpeg reports output) → error → connecting again after backoff (capped at
 * 60 s) … → stopped when the broadcast ends.
 *
 * Targets are user-supplied URLs: only `rtmp:`/`rtmps:` to public addresses, vetted right before
 * each spawn (net/ssrf.ts). The stream key is in ffmpeg's argv; the media container's own PID
 * namespace keeps it from other local users (README "Secrets"), and every log line is redacted.
 * `lastError` (shown to the streamer) is one of the generic SIMULCAST_ERRORS codes.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { SIMULCAST_STATUSES } from "@commonair/contracts/enums";
import { KEYS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { decryptSecret } from "@commonair/tokens";
import type { BroadcastInfo, MediaContext } from "./context.ts";
import { internalRtspUrl, simulcastArgs, simulcastOutput } from "./ffmpeg/args.ts";
import { Supervisor } from "./ffmpeg/supervisor.ts";
import { parseTargetUrl, resolveTarget, TargetNotAllowedError, type ParsedTarget } from "./net/ssrf.ts";
import { SIMULCAST_MAX_BACKOFF_MS, SIMULCAST_SECRET_PURPOSE } from "./settings.ts";

export type SimulcastStatus = (typeof SIMULCAST_STATUSES)[number];
const STATUS_TTL_SECONDS = 24 * 3600;

/** Generic, stable `lastError` codes (the web app translates them); never ffmpeg output. */
export const SIMULCAST_ERRORS = {
  keyUnreadable: "stream_key_unreadable",
  targetNotAllowed: "target_not_allowed",
  connectionFailed: "connection_failed",
} as const;
export type SimulcastError = (typeof SIMULCAST_ERRORS)[keyof typeof SIMULCAST_ERRORS];

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
    let target: ParsedTarget;
    try {
      target = parseTargetUrl(this.target.rtmpUrl);
    } catch (err) {
      this.log.warn("simulcast target refused", {
        reason: err instanceof TargetNotAllowedError ? err.reason : "invalid",
      });
      await this.setStatus("error", SIMULCAST_ERRORS.targetNotAllowed);
      return;
    }
    let key: string;
    try {
      key = await decryptSecret(this.ctx.authSecret, SIMULCAST_SECRET_PURPOSE, this.target.streamKeyCiphertext);
    } catch {
      // Rotating AUTH_SECRET invalidates stored keys; the streamer must re-enter the key.
      this.log.warn("simulcast stream key could not be decrypted");
      await this.setStatus("error", SIMULCAST_ERRORS.keyUnreadable);
      return;
    }
    if (key.length === 0) {
      await this.setStatus("error", SIMULCAST_ERRORS.keyUnreadable);
      return;
    }
    if (this.stopping) return;
    const { rtspBase, internalSecret } = this.ctx;
    const input = internalRtspUrl(rtspBase, this.b.path, internalSecret);
    // The whole target URL is secret (keys hide in paths and query strings too). The list is
    // shared with the supervisor, so each spawn's actual output URL joins it before any logging.
    const secrets: string[] = [key, internalSecret, this.target.rtmpUrl];
    if (target.search.length > 1) secrets.push(target.search);
    let refused = false;
    await this.setStatus("connecting", null);
    this.supervisor = new Supervisor({
      name: `simulcast:${this.target.id}`,
      binary: this.ctx.ffmpeg,
      // Resolve and vet right before every spawn: a target that later resolves to an internal
      // address is refused (the supervisor treats the throw as a failed run and backs off).
      args: async () => {
        let address: string;
        try {
          ({ address } = await resolveTarget(target, { allowPrivate: this.ctx.simulcastAllowPrivate }));
        } catch (err) {
          refused = err instanceof TargetNotAllowedError;
          this.log.warn("simulcast target refused", {
            reason: refused ? (err as TargetNotAllowedError).reason : "dns",
          });
          throw new Error("simulcast target not allowed");
        }
        refused = false;
        const out = simulcastOutput(target, key, address);
        if (!secrets.includes(out.url)) secrets.push(out.url);
        return simulcastArgs(input, out);
      },
      secrets,
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
        // The supervisor already logged the (redacted) ffmpeg line; the streamer sees a code.
        this.log.warn("simulcast ffmpeg exited", { code: info.code, refused });
        void this.setStatus("error", refused ? SIMULCAST_ERRORS.targetNotAllowed : SIMULCAST_ERRORS.connectionFailed);
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
