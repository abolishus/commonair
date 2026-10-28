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
import { firstSampleSeconds, runOffsetMs, writeSidecar } from "../clock/run.ts";
import { opensNearWrap, W0Error } from "../clock/w0.ts";
import type { BroadcastInfo, MediaContext } from "../context.ts";
import { internalSrtUrl, recorderArgs, recorderPlaylist } from "../ffmpeg/args.ts";
import { Supervisor } from "../ffmpeg/supervisor.ts";
import { sourceInfo } from "../mediamtx.ts";
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

/** Wait this long after a failed W0 fetch before the recorder asks again. */
const W0_RETRY_MS = 5_000;
/** Give up anchoring a run after this many unreadable segments (it stays on raw times). */
const MAX_ANCHOR_FAILURES = 3;

/** One ffmpeg run's clock (R4, `clock/run.ts`). */
interface RunState {
  /** Raw start of the run's first segment ever seen (pruning never moves it). */
  firstRaw: Date | null;
  w0Ms: number | null;
  offsetMs: number | null;
  fetching: boolean;
  nextW0At: number;
  anchorFailures: number;
  /** Sidecar writes, in order (a late W0 write must never land after the offset's). */
  writes: Promise<void>;
  /**
   * The MediaMTX source (publisher connection) the run read. W0 belongs to that source's stream
   * timeline; a publisher reconnect inside one broadcast session starts a new one.
   */
  sourceId: string | null;
  /** Host time ffmpeg was started for this run (null for runs this process did not start). */
  openedAtMs: number | null;
  /** ffmpeg for this run has exited: no more W0 fetches for it. */
  ended: boolean;
  /** Why the run stays on raw times for good (W0 not valid for it), or null. */
  unanchorable: string | null;
}

export class SegmentRecorder {
  private supervisor: Supervisor | null = null;
  private loop: Loop | null = null;
  private readonly runs: string[] = [];
  private readonly clocks = new Map<string, RunState>();
  private local: LocalSegment[] = [];
  private readonly known = new Set<string>();
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
    const { srtBase, internalSecret, timings } = this.ctx;
    this.supervisor = new Supervisor({
      name: `recorder:${this.b.slug}`,
      binary: this.ctx.ffmpeg,
      args: async () => {
        const input = internalSrtUrl(srtBase, this.b.path, internalSecret);
        // AAC arrives over SRT with ADTS headers that MP4 needs rewrapped; Opus must not be.
        const path = await this.ctx.mtx.getPath(this.b.path);
        if (!path) throw new Error("source path not ready");
        const aacAudio = sourceInfo(path).audioCodec === "MPEG-4 Audio";
        // Base-36 time keeps run ids short, unique per broadcast and sortable.
        const runId = `r${Date.now().toString(36)}`;
        this.beginRun(runId, path.source?.id ?? null, Date.now());
        return recorderArgs({ input, dir: this.dir, runId, segmentSeconds: timings.segmentSeconds, aacAudio });
      },
      onExit: () => this.endRun(),
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
    const { clock } = this.ctx;
    const id = this.b.broadcastId;
    setTimeout(() => {
      // Run offsets serve live clips from the local buffer until it is gone.
      clock.forget(id);
      void rm(dir, { recursive: true, force: true });
    }, LOCAL_GRACE_MS).unref();
  }

  private runState(runId: string): RunState {
    let s = this.clocks.get(runId);
    if (!s) {
      s = {
        firstRaw: null,
        w0Ms: null,
        offsetMs: null,
        fetching: false,
        nextW0At: 0,
        anchorFailures: 0,
        writes: Promise.resolve(),
        sourceId: null,
        openedAtMs: null,
        ended: false,
        unanchorable: null,
      };
      this.clocks.set(runId, s);
    }
    return s;
  }

  /** A new ffmpeg run reading `sourceId`'s stream. Never waits: W0 is fetched in the background. */
  private beginRun(runId: string, sourceId: string | null, openedAtMs: number): void {
    this.endRun();
    this.runs.push(runId);
    const s = this.runState(runId);
    s.sourceId = sourceId;
    s.openedAtMs = openedAtMs;
    this.requestW0(runId);
  }

  /** The current run's ffmpeg exited (or never started): its W0 can no longer be fetched. */
  private endRun(): void {
    const last = this.runs.at(-1);
    if (last) this.runState(last).ended = true;
  }

  /** Mark a run as never anchorable: it keeps raw times (offset 0), logged once. */
  private giveUp(runId: string, s: RunState, reason: string): void {
    if (s.unanchorable) return;
    s.unanchorable = reason;
    this.log.warn("recorder run left on raw times", { runId, reason });
  }

  /** W0 may only be fetched for the run ffmpeg is still writing, while it reads its own source. */
  private isCurrent(runId: string, s: RunState): boolean {
    return this.runs.at(-1) === runId && !s.ended && !s.unanchorable && !this.stopping;
  }

  /** Queue a sidecar write behind the run's earlier ones; resolves (or rejects) with this one. */
  private persist(runId: string, s: RunState, w0Ms: number | null, offsetMs: number | null): Promise<void> {
    const write = s.writes.then(() => writeSidecar(this.dir, { runId, w0Ms, offsetMs }));
    s.writes = write.catch(() => {});
    return write;
  }

  /**
   * Fetch W0 for the current run in the background (one at a time, backing off after a failure).
   * W0 is only valid for the stream timeline the run read, so a result is kept only if the run is
   * still current and MediaMTX still has the same source on the path; otherwise the run stays raw.
   */
  private requestW0(runId: string): void {
    const s = this.runState(runId);
    if (s.w0Ms !== null || s.fetching || !this.isCurrent(runId, s) || Date.now() < s.nextW0At) return;
    s.fetching = true;
    const fetched = this.ctx.clock.w0(this.b.broadcastId, this.b.path, "recorder").then(
      (w0Ms) => w0Ms,
      (err: unknown) => {
        // Counted and logged by the clock. A wrap refusal means this run may have opened in
        // ffmpeg's negative-time window: its file times cannot be trusted against any W0.
        if (err instanceof W0Error && err.reason === "wrap") this.giveUp(runId, s, "pts_wrap");
        s.nextW0At = Date.now() + W0_RETRY_MS;
        return null;
      },
    );
    void fetched
      .then(async (w0Ms) => {
        if (w0Ms === null || !this.isCurrent(runId, s)) return;
        const path = await this.ctx.mtx.getPath(this.b.path);
        if (!this.isCurrent(runId, s)) return;
        if ((path?.source?.id ?? null) !== s.sourceId) {
          this.giveUp(runId, s, "source_changed");
          return;
        }
        s.w0Ms = w0Ms;
        await this.persist(runId, s, w0Ms, s.offsetMs).catch((err: unknown) =>
          this.log.warn("could not write the run clock sidecar", { error: errorCategory(err) }),
        );
      })
      .catch((err: unknown) => {
        // MediaMTX unreachable: retried on a later poll.
        s.nextW0At = Date.now() + W0_RETRY_MS;
        this.log.debug("could not confirm the recorder run's source", { error: errorCategory(err) });
      })
      .finally(() => {
        s.fetching = false;
      });
  }

  /**
   * Anchor a run from one of its segments (W0 known): `offset = W0 + first sample − raw PDT`. The
   * offset is persisted in the run's sidecar for crash recovery before any stamped time uses it.
   */
  private async anchorRun(
    runId: string,
    s: RunState,
    seg: { map: string | null; localPath: string; startedAt: Date | null },
  ) {
    if (s.w0Ms === null || s.offsetMs !== null || s.unanchorable || !seg.map || !seg.startedAt) return;
    if (s.anchorFailures >= MAX_ANCHOR_FAILURES) return;
    // Opened in ffmpeg's negative-time window before the wrap: its times may have been shifted.
    if (s.openedAtMs !== null && opensNearWrap((s.openedAtMs - s.w0Ms) / 1000)) {
      this.giveUp(runId, s, "pts_wrap");
      return;
    }
    try {
      const t = await firstSampleSeconds(join(this.dir, seg.map), seg.localPath);
      if (t < 0) {
        this.giveUp(runId, s, "negative_time");
        return;
      }
      const offset = runOffsetMs(s.w0Ms, t, seg.startedAt.getTime());
      await this.persist(runId, s, s.w0Ms, offset);
      s.offsetMs = offset;
      this.ctx.clock.setRunOffset(this.b.broadcastId, runId, offset);
      this.ctx.clock.metrics.recorderOffset(offset);
      this.log.info("recorder run anchored", { runId, offsetMs: Math.round(offset) });
    } catch (err) {
      if (++s.anchorFailures >= MAX_ANCHOR_FAILURES)
        this.log.warn("could not anchor a recorder run; it keeps raw times", { runId, error: errorCategory(err) });
    }
  }

  /** Production live-to-VOD gauge: how far a stamped segment is from `W0 + its own first sample`. */
  private async checkResidual(s: RunState, seg: { map: string | null; localPath: string; startedAt: Date | null }) {
    if (s.w0Ms === null || s.offsetMs === null || !seg.map || !seg.startedAt) return;
    try {
      const t = await firstSampleSeconds(join(this.dir, seg.map), seg.localPath);
      // (W0 + t) − stamped, folded like an offset (the metric takes the magnitude).
      this.ctx.clock.metrics.recorderResidual(runOffsetMs(s.w0Ms, t, seg.startedAt.getTime() + s.offsetMs));
    } catch {
      // A gauge only: an unreadable segment is not worth a log line per segment.
    }
  }

  /** Anchored start of the first segment ever recorded, re-stamped on every read (ADR 0012). */
  private recordingStartedAt(): Date | null {
    let first: Date | null = null;
    for (const [runId, s] of this.clocks) {
      const at = this.stamp(runId, s.firstRaw);
      if (at && (!first || at < first)) first = at;
    }
    return first;
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
    const found = findLiveWindow(anchored, this.recordingStartedAt(), start, durationSeconds);
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
      const clock = this.runState(runId);
      // Only the current run: an ended run's W0 would come from whatever stream the path has now.
      if (clock.w0Ms === null) this.requestW0(runId);
      // W0 arrived after the run's first segments were seen: anchor from the oldest still on disk.
      if (clock.w0Ms !== null && clock.offsetMs === null) {
        const oldest = this.local.find((l) => l.runId === runId);
        if (oldest) await this.anchorRun(runId, clock, oldest);
      }
      const file = Bun.file(join(this.dir, recorderPlaylist(runId)));
      if (!(await file.exists())) continue;
      for (const s of parsePlaylist(await file.text()).segments) {
        const uri = basename(s.uri);
        if (this.known.has(uri)) continue;
        this.known.add(uri);
        const seg: LocalSegment = {
          ...s,
          uri,
          map: s.map ? basename(s.map) : null,
          runId,
          localPath: join(this.dir, uri),
          uploaded: false,
        };
        // Anchored before the segment is pushed, so no stamped time leaves unanchored once W0 is known.
        if (clock.offsetMs === null) await this.anchorRun(runId, clock, seg);
        else await this.checkResidual(clock, seg);
        clock.firstRaw ??= s.startedAt;
        this.local.push(seg);
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
