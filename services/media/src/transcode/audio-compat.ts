// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An AAC copy of the source for players that cannot decode its audio. WHIP ingests carry Opus,
 * which MediaMTX muxes into HLS as is and WebKit's native HLS (Safari, iOS) does not play. While
 * the source's audio is not AAC, ffmpeg re-encodes the audio (video copied) to
 * `sourceAacPath`; once it produces output, `KEYS.sourceAac` tells the origin to serve that copy
 * wherever clients ask for the source. Independent of viewer count and of the ladder.
 */
import { KEYS, SOURCE_AAC_STATES, sourceAacPath } from "@commonair/contracts/internal";
import type { BroadcastInfo, MediaContext } from "../context.ts";
import { aacCopyArgs, internalRtspUrl } from "../ffmpeg/args.ts";
import { Supervisor } from "../ffmpeg/supervisor.ts";
import { every, type Loop } from "../loop.ts";
import { needsAacCopy, sourceInfo } from "../mediamtx.ts";

/** Key lifetime; refreshed every poll, so a crashed service stops redirecting the origin quickly. */
export const SOURCE_AAC_TTL_SECONDS = 30;
/**
 * How long viewers may be held back ("pending") while the copy starts. Past it the original source
 * is served again, so a copy that cannot start never makes the stream unwatchable.
 */
export const SOURCE_AAC_PENDING_MAX_MS = 20_000;

export class AudioCompat {
  private loop: Loop | null = null;
  private copy: Supervisor | null = null;
  private advertised = false;
  /** When "pending" was set; null when not pending (live, given up, or not needed). */
  private pendingSince: number | null = null;
  /** Decided once the source's tracks are known; null until then. */
  private needed: boolean | null = null;
  private readonly log;

  constructor(
    private readonly ctx: MediaContext,
    private readonly b: BroadcastInfo,
  ) {
    this.log = ctx.logger.child({ broadcastId: b.broadcastId, worker: "audio-compat" });
  }

  get active(): boolean {
    return this.copy !== null;
  }

  async start(): Promise<void> {
    // A previous process may have died while advertising.
    await this.withdraw();
    this.loop = every(this.ctx.timings.transcodePollMs, () => this.tick(), {
      logger: this.log,
      name: "audio-compat",
      initialDelayMs: 0,
    });
  }

  async stop(): Promise<void> {
    await this.loop?.stop();
    this.loop = null;
    const copy = this.copy;
    this.copy = null;
    await copy?.stop();
    await this.withdraw();
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.needed === null) {
      const path = await this.ctx.mtx.getPath(this.b.path);
      // Tracks appear once the publisher is ready; ask again next poll.
      if (!path || path.tracks.length === 0) return;
      const info = sourceInfo(path);
      this.needed = needsAacCopy(info);
      if (!this.needed) return;
      this.log.info("source audio is not AAC; publishing an AAC copy", { audio: info.audioCodec });
      await this.markPending(now);
      this.startCopy();
      return;
    }
    if (this.pendingSince !== null && now - this.pendingSince > SOURCE_AAC_PENDING_MAX_MS) {
      this.log.warn("AAC copy not live in time; serving the original source", { errorCode: "SOURCE_AAC_SLOW" });
      await this.withdraw();
      return;
    }
    if (this.advertised || this.pendingSince !== null)
      await this.ctx.valkey.expire(KEYS.sourceAac(this.b.channelId), SOURCE_AAC_TTL_SECONDS);
  }

  private async markPending(now: number): Promise<void> {
    this.pendingSince = now;
    try {
      await this.ctx.valkey.set(
        KEYS.sourceAac(this.b.channelId),
        SOURCE_AAC_STATES.pending,
        "EX",
        SOURCE_AAC_TTL_SECONDS,
      );
    } catch {
      this.log.warn("could not mark the AAC copy pending", { errorCode: "SOURCE_AAC_PENDING_FAILED" });
    }
  }

  private startCopy(): void {
    const { rtspBase, internalSecret } = this.ctx;
    const input = internalRtspUrl(rtspBase, this.b.path, internalSecret);
    const output = internalRtspUrl(rtspBase, sourceAacPath(this.b.slug), internalSecret);
    this.copy = new Supervisor({
      name: `aac:${this.b.slug}`,
      binary: this.ctx.ffmpeg,
      args: () => aacCopyArgs(input, output),
      secrets: [internalSecret],
      logger: this.log,
      onProgress: (p) => {
        if (!this.advertised && p.frame !== null && p.frame > 0) void this.advertise();
      },
      // Hold viewers back while ffmpeg restarts (WebKit cannot decode the original); the pending
      // limit falls back to the original if the copy does not come back.
      onExit: (_info, restartInMs) => {
        if (restartInMs === null) return;
        if (this.advertised) {
          this.advertised = false;
          void this.markPending(Date.now());
        }
      },
    });
    this.copy.start();
  }

  private async advertise(): Promise<void> {
    this.advertised = true;
    this.pendingSince = null;
    try {
      await this.ctx.valkey.set(KEYS.sourceAac(this.b.channelId), SOURCE_AAC_STATES.live, "EX", SOURCE_AAC_TTL_SECONDS);
      this.log.info("AAC copy of the source live");
    } catch {
      this.log.warn("could not advertise the AAC copy", { errorCode: "SOURCE_AAC_ADVERTISE_FAILED" });
    }
  }

  private async withdraw(): Promise<void> {
    this.advertised = false;
    this.pendingSince = null;
    try {
      await this.ctx.valkey.del(KEYS.sourceAac(this.b.channelId));
    } catch {
      this.log.warn("could not withdraw the AAC copy", { errorCode: "SOURCE_AAC_WITHDRAW_FAILED" });
    }
  }
}
