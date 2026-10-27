// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One `-c copy` recorder per live broadcast writes fMP4 HLS segments to a local directory. It
 * serves two purposes:
 *
 * - a rolling ~90 s buffer for live clips (always), and
 * - VOD recording (when the channel has VODs enabled): each finished segment, then the
 *   playlist, is uploaded under the VOD's `storage_prefix` as soon as ffmpeg closes it, so a crash
 *   loses at most the segment being written. New VODs record under the private
 *   `recordings/<vodId>/` (ADR 0009 amendment 1); a VOD resumed across the upgrade keeps its old
 *   `vods/<vodId>/` and finalize moves it. A restart resumes the same VOD with a discontinuity.
 */
import { mkdir, rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { isVodOwnPrefix, VOD_PLAYLIST } from "@commonair/contracts/storage";
import { schema } from "@commonair/db";
import type { BroadcastInfo, MediaContext } from "../context.ts";
import { internalRtspUrl, recorderArgs, recorderPlaylist } from "../ffmpeg/args.ts";
import { Supervisor } from "../ffmpeg/supervisor.ts";
import { every, type Loop } from "../loop.ts";
import { MAX_PENDING_UPLOADS } from "../settings.ts";
import { errorCategory } from "../moderation/logging.ts";
import { findLiveWindow, parsePlaylist, renderPlaylist, type PlaylistSegment } from "./playlist.ts";

export { VOD_PLAYLIST };

/** How long a finished broadcast's local buffer survives, for clips requested right at the end. */
const LOCAL_GRACE_MS = 5 * 60_000;

/** `startedAt` is the raw host time ffmpeg wrote; `stamp` applies the clock anchor on the way out. */
interface LocalSegment extends PlaylistSegment {
  /** Recorder run (the segment file prefix), whose anchor offset applies. */
  runId: string;
  localPath: string;
  uploaded: boolean;
}

/** A VOD playlist entry. `runId` null: resumed from storage, already stamped by an earlier process. */
interface PublishedSegment extends PlaylistSegment {
  runId: string | null;
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
  /** Anchored start of the first segment ever recorded (pruning never moves it). */
  private recordingStartedAt: Date | null = null;
  /** Everything already in the published VOD playlist, in order. */
  private published: PublishedSegment[] = [];
  /** The playlist text last uploaded; re-rendered each poll so a re-anchored run is re-stamped. */
  private lastPlaylist: string | null = null;
  private playlistStale = false;
  private readonly uploadedInits = new Set<string>();
  private readonly dir: string;
  private readonly log;
  private polling: Promise<void> = Promise.resolve();
  private refused = false;
  private stopping = false;
  /** The VOD's `storage_prefix`, read once; nothing is uploaded until it is known. */
  private prefix: string | null;
  private resumed = false;

  constructor(
    private readonly ctx: MediaContext,
    private readonly b: BroadcastInfo,
    private readonly vodId: string | null,
    /** The VOD row's `storage_prefix` when the caller has it; otherwise read from the row at start. */
    storagePrefix: string | null = null,
  ) {
    this.prefix = storagePrefix;
    this.dir = join(ctx.workDir, "broadcasts", b.broadcastId);
    this.log = ctx.logger.child({ broadcastId: b.broadcastId, vodId, worker: "recorder" });
  }

  /** True while recording is refused because the work dir is over its disk budget. */
  get diskRefused(): boolean {
    return this.refused;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (this.vodId) await this.vodTarget(this.vodId);
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

  /** A raw segment time on the broadcast clock (ADR 0012). */
  private stamp(runId: string | null, at: Date | null): Date | null {
    if (!at || runId === null) return at;
    const offset = this.ctx.clock.offsetMs(this.b.broadcastId, runId);
    return offset === 0 ? at : new Date(at.getTime() + offset);
  }

  /** Local segments covering a wall-clock window (broadcast clock), for live clips. */
  localWindow(start: Date, durationSeconds: number): LocalLookup {
    const anchored = this.local.map((s) => ({ ...s, startedAt: this.stamp(s.runId, s.startedAt) }));
    const found = findLiveWindow(anchored, this.recordingStartedAt, start, durationSeconds);
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
        const startedAt = this.stamp(runId, s.startedAt);
        if (startedAt && (!this.recordingStartedAt || startedAt < this.recordingStartedAt))
          this.recordingStartedAt = startedAt;
        this.local.push({ ...s, uri, map, runId, localPath: join(this.dir, uri), uploaded: false });
      }
    }
    if (this.vodId) {
      const prefix = await this.vodTarget(this.vodId);
      if (prefix) await this.upload(prefix, strict);
      // Strict quiescence must not report success with segments still only on local disk.
      else if (strict) throw new Error("VOD storage prefix unknown; segments not uploaded");
    }
    await this.prune();
  }

  /**
   * The VOD's object prefix, read from its row (retried on each poll until it succeeds), and the
   * already published playlist resumed from it once. Null while unknown: segments wait locally.
   */
  private async vodTarget(vodId: string): Promise<string | null> {
    if (!this.prefix) {
      try {
        const [row] = await this.ctx.db
          .select({ prefix: schema.vods.storagePrefix })
          .from(schema.vods)
          .where(eq(schema.vods.id, vodId));
        // Only the VOD's own prefixes: a tampered row must never make the recorder write elsewhere.
        if (row && isVodOwnPrefix(vodId, row.prefix)) this.prefix = row.prefix;
        else this.log.error("VOD storage prefix missing or unexpected; not uploading");
      } catch (err) {
        this.log.warn("could not read the VOD storage prefix; will retry", { error: errorCategory(err) });
      }
    }
    if (this.prefix && !this.resumed) {
      this.resumed = true;
      await this.resumePublished(this.prefix);
    }
    return this.prefix;
  }

  private async resumePublished(prefix: string): Promise<void> {
    try {
      const res = await this.ctx.storage.get(this.ctx.bucket, prefix + VOD_PLAYLIST);
      if (!res) return;
      this.published = parsePlaylist(await res.text()).segments.map((s) => ({ ...s, runId: null }));
      for (const s of this.published) if (s.map) this.uploadedInits.add(s.map);
      this.log.info("resuming VOD recording", { segments: this.published.length });
    } catch (err) {
      this.log.warn("could not read existing VOD playlist; continuing with a new one", { error: errorCategory(err) });
    }
  }

  private async upload(prefix: string, strict: boolean): Promise<void> {
    const { storage, bucket } = this.ctx;
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
        runId: seg.runId,
      });
      changed = true;
    }
    if (changed) this.playlistStale = true;
    // Nothing new and no playlist written yet by this process: nothing to (re-)stamp.
    if (!this.playlistStale && this.lastPlaylist === null) return;
    const stamped = this.published.map((p) => ({
      uri: p.uri,
      durationSeconds: p.durationSeconds,
      startedAt: this.stamp(p.runId, p.startedAt),
      map: p.map,
    }));
    const text = renderPlaylist(stamped, { ended: false });
    if (text !== this.lastPlaylist)
      await storage.put(bucket, prefix + VOD_PLAYLIST, text, {
        contentType: "application/vnd.apple.mpegurl",
        cacheControl: "no-cache",
      });
    this.lastPlaylist = text;
    this.playlistStale = false;
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
