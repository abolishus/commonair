// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One `-c copy` recorder per live broadcast writes fMP4 HLS segments to a local directory. It
 * serves two purposes:
 *
 * - a rolling ~90 s buffer for live clips (always), and
 * - VOD recording (when the channel has VODs enabled): each finished segment, then the
 *   playlist, is uploaded to `vods/<vodId>/` as soon as ffmpeg closes it, so a crash loses at
 *   most the segment being written. A restart resumes the same VOD with a discontinuity.
 */
import { mkdir, rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BroadcastInfo, MediaContext } from "../context.ts";
import { internalRtspUrl, recorderArgs, recorderPlaylist } from "../ffmpeg/args.ts";
import { Supervisor } from "../ffmpeg/supervisor.ts";
import { every, type Loop } from "../loop.ts";
import { MAX_PENDING_UPLOADS } from "../settings.ts";
import { errorCategory } from "../moderation/logging.ts";
import { findLiveWindow, parsePlaylist, renderPlaylist, type PlaylistSegment } from "./playlist.ts";

export const vodPrefix = (vodId: string) => `vods/${vodId}/`;
export const VOD_PLAYLIST = "index.m3u8";

/** How long a finished broadcast's local buffer survives, for clips requested right at the end. */
const LOCAL_GRACE_MS = 5 * 60_000;

interface LocalSegment extends PlaylistSegment {
  localPath: string;
  uploaded: boolean;
}

export interface LocalWindow {
  initPath: string;
  segmentPaths: string[];
  offsetSeconds: number;
  durationSeconds: number;
}

/** `pending`: live here, but the window is not on disk yet. `null`: outside the buffer. */
export type LocalLookup = LocalWindow | "pending" | null;

export class SegmentRecorder {
  private supervisor: Supervisor | null = null;
  private loop: Loop | null = null;
  private readonly runs: string[] = [];
  private local: LocalSegment[] = [];
  private readonly known = new Set<string>();
  /** Start of the first segment ever recorded (pruning never moves it). */
  private recordingStartedAt: Date | null = null;
  /** Everything already in the published VOD playlist, in order. */
  private published: PlaylistSegment[] = [];
  private readonly uploadedInits = new Set<string>();
  private readonly dir: string;
  private readonly log;
  private polling: Promise<void> = Promise.resolve();
  private refused = false;
  private stopping = false;

  constructor(
    private readonly ctx: MediaContext,
    private readonly b: BroadcastInfo,
    private readonly vodId: string | null,
  ) {
    this.dir = join(ctx.workDir, "broadcasts", b.broadcastId);
    this.log = ctx.logger.child({ broadcastId: b.broadcastId, vodId, worker: "recorder" });
  }

  /** True while recording is refused because the work dir is over its disk budget. */
  get diskRefused(): boolean {
    return this.refused;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (this.vodId) await this.resumePublished(this.vodId);
    await this.startRecording();
    this.loop = every(this.ctx.timings.recorderPollMs, () => this.poll(), { logger: this.log, name: "recorder-poll" });
  }

  /**
   * Start ffmpeg unless the disk budget refuses it; the poll loop retries, so recording begins
   * (late, with a gap in the VOD) once space is available again.
   */
  private async startRecording(): Promise<void> {
    if (this.supervisor || this.stopping) return;
    const verdict = await this.ctx.diskBudget.check("recording");
    if (!verdict.ok) {
      if (!this.refused)
        this.log.warn("recording refused: media work dir over disk budget", { reason: verdict.reason });
      this.refused = true;
      return;
    }
    if (this.refused) this.log.info("disk budget available again; recording starts");
    this.refused = false;
    const { rtspBase, internalSecret, timings } = this.ctx;
    const input = internalRtspUrl(rtspBase, this.b.path, internalSecret);
    this.supervisor = new Supervisor({
      name: `recorder:${this.b.slug}`,
      binary: this.ctx.ffmpeg,
      args: () => {
        // Base-36 time keeps run ids short, unique per broadcast and sortable.
        const runId = `r${Date.now().toString(36)}`;
        this.runs.push(runId);
        return recorderArgs({ input, dir: this.dir, runId, segmentSeconds: timings.segmentSeconds });
      },
      secrets: [internalSecret],
      logger: this.log,
      stopGraceMs: 10_000,
    });
    this.supervisor.start();
  }

  /**
   * Stop recording. `final` means the broadcast ended: flush everything, then let the caller
   * finalize the VOD. On service shutdown (`final` false) the VOD stays `recording` and a new
   * process resumes it.
   */
  async stop(final: boolean, strict = false): Promise<void> {
    this.stopping = true;
    await this.loop?.stop();
    this.loop = null;
    await this.supervisor?.stop();
    this.supervisor = null;
    await this.poll(strict);
    if (!final) return;
    const dir = this.dir;
    setTimeout(() => void rm(dir, { recursive: true, force: true }), LOCAL_GRACE_MS).unref();
  }

  /** Local segments covering a wall-clock window, for live clips. */
  localWindow(start: Date, durationSeconds: number): LocalLookup {
    const found = findLiveWindow(this.local, this.recordingStartedAt, start, durationSeconds);
    if (found.status === "pending") return "pending";
    if (found.status === "outside") return null;
    const w = found.window;
    const first = w.segments[0];
    if (!first?.map) return null;
    return {
      initPath: join(this.dir, first.map),
      segmentPaths: w.segments.map((s) => join(this.dir, s.uri)),
      offsetSeconds: w.offsetSeconds,
      durationSeconds: w.durationSeconds,
    };
  }

  private poll(strict = false): Promise<void> {
    // Serialize: stop() polls once more while a scheduled poll may still be running.
    this.polling = this.polling
      .catch(() => {})
      .then(() => this.pollOnce(strict))
      .catch((err: unknown) => {
        this.log.warn("recorder poll failed", { error: errorCategory(err) });
        if (strict) throw err;
      });
    return this.polling;
  }

  private async pollOnce(strict: boolean): Promise<void> {
    if (this.refused) await this.startRecording();
    for (const runId of this.runs) {
      const file = Bun.file(join(this.dir, recorderPlaylist(runId)));
      if (!(await file.exists())) continue;
      for (const s of parsePlaylist(await file.text()).segments) {
        const uri = basename(s.uri);
        if (this.known.has(uri)) continue;
        this.known.add(uri);
        const map = s.map ? basename(s.map) : null;
        if (s.startedAt && (!this.recordingStartedAt || s.startedAt < this.recordingStartedAt))
          this.recordingStartedAt = s.startedAt;
        this.local.push({ ...s, uri, map, localPath: join(this.dir, uri), uploaded: false });
      }
    }
    if (this.vodId) await this.upload(this.vodId, strict);
    await this.prune();
  }

  private async resumePublished(vodId: string): Promise<void> {
    try {
      const res = await this.ctx.storage.get(this.ctx.bucket, vodPrefix(vodId) + VOD_PLAYLIST);
      if (!res) return;
      this.published = parsePlaylist(await res.text()).segments;
      for (const s of this.published) if (s.map) this.uploadedInits.add(s.map);
      this.log.info("resuming VOD recording", { segments: this.published.length });
    } catch (err) {
      this.log.warn("could not read existing VOD playlist; continuing with a new one", { error: errorCategory(err) });
    }
  }

  private async upload(vodId: string, strict: boolean): Promise<void> {
    const { storage, bucket } = this.ctx;
    const prefix = vodPrefix(vodId);
    let changed = false;
    for (const seg of this.local) {
      if (seg.uploaded) continue;
      try {
        if (seg.map && !this.uploadedInits.has(seg.map)) {
          await storage.put(bucket, prefix + seg.map, await Bun.file(join(this.dir, seg.map)).bytes(), {
            contentType: "video/mp4",
          });
          this.uploadedInits.add(seg.map);
        }
        await storage.put(bucket, prefix + seg.uri, await Bun.file(seg.localPath).bytes(), {
          contentType: "video/iso.segment",
        });
      } catch (err) {
        // Keep order: later segments wait until this one is up, so the playlist never has holes.
        this.log.warn("segment upload failed; will retry", { error: errorCategory(err) });
        if (strict) throw err;
        break;
      }
      seg.uploaded = true;
      this.published.push({
        uri: seg.uri,
        durationSeconds: seg.durationSeconds,
        startedAt: seg.startedAt,
        map: seg.map,
      });
      changed = true;
    }
    if (!changed) return;
    await storage.put(bucket, prefix + VOD_PLAYLIST, renderPlaylist(this.published, { ended: false }), {
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "no-cache",
    });
  }

  private async prune(): Promise<void> {
    const cutoff = Date.now() - this.ctx.timings.clipBufferSeconds * 1000;
    const pending = this.local.filter((s) => !s.uploaded).length;
    const keep: LocalSegment[] = [];
    let dropBacklog = this.vodId ? Math.max(0, pending - MAX_PENDING_UPLOADS) : 0;
    for (const s of this.local) {
      const end = (s.startedAt?.getTime() ?? 0) + s.durationSeconds * 1000;
      const expired = end < cutoff;
      const uploadedOrNoVod = s.uploaded || !this.vodId;
      let drop = expired && uploadedOrNoVod;
      if (!drop && !s.uploaded && dropBacklog > 0) {
        // Object storage has been down for a long time: bound local disk use.
        this.log.error("dropping unuploaded VOD segment (storage unavailable too long)");
        dropBacklog--;
        drop = true;
      }
      if (drop) await unlink(s.localPath).catch(() => {});
      else keep.push(s);
    }
    this.local = keep;
  }
}
