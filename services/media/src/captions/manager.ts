// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live captions on one media host (ADR 0011): which broadcasts get a worker, in what order, and
 * what happens to their transcript at the end.
 *
 * - **Start.** An eligible broadcast (`settings.ts`) gets a `broadcast_caption_tracks` row. With a
 *   free slot (`CAPTIONS_MAX_STREAMS`, its own `SlotLimiter`, never a transcode slot) it starts at
 *   once (`active`); otherwise it waits in a FIFO queue in start order (`queued`).
 * - **End** (and a crashed stream, which ends its session): the slot is released and the next
 *   queued broadcast starts. With a VOD, the cues are stitched into `<storage_prefix>captions/
 *   <lang>.vtt` before `onEnd` resolves, which is before `vod-finalize` is enqueued (the session
 *   hook contract), so finalize's move carries the track with the VOD; the track is then `ready`.
 *   With no VOD, the cues are deleted and the track is `deleted` (ADR 0011 decision 6).
 * - **Shutdown** (`final` false): the worker stops and the slot is freed, but the row and the
 *   Valkey cues stay, so the successor host resumes the same track.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Valkey } from "iovalkey";
import { toVodCues, vodVttDocument } from "@commonair/captions";
import { isVodOwnPrefix, VOD_PLAYLIST, vodCaptionsKey } from "@commonair/contracts/storage";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import type { MediaSessionInfo, SessionEnd, SessionStart } from "../hooks.ts";
import { errorCategory } from "../moderation/logging.ts";
import type { SlotLimiter } from "../transcode/slots.ts";
import type { CaptionsMetrics } from "./metrics.ts";
import { ineligibility, loadChannelCaptions } from "./settings.ts";
import type { AudioSource } from "./source.ts";
import { LiveCueStore } from "./store.ts";
import { CaptionStream } from "./stream.ts";
import type { Transcriber } from "./whisper.ts";

const { broadcastCaptionTracks: tracks, vods } = schema;

export interface ManagerDeps {
  db: Database;
  valkey: Valkey;
  storage: ObjectStorage;
  bucket: string;
  logger: Logger;
  slots: SlotLimiter;
  whisperUrl: string | undefined;
  source: AudioSource;
  transcriber: Transcriber;
  metrics: CaptionsMetrics;
  backoff?: { initialMs: number; maxMs: number };
  now?: () => number;
}

interface Waiting {
  session: MediaSessionInfo;
  language: string;
}

/** The first `EXT-X-PROGRAM-DATE-TIME` of a media playlist (the VOD's time 0), or null. */
export function firstProgramDateTime(playlist: string): number | null {
  const m = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/m.exec(playlist);
  if (!m?.[1]) return null;
  const t = Date.parse(m[1].trim());
  return Number.isFinite(t) ? t : null;
}

export class CaptionsManager {
  private readonly streams = new Map<string, CaptionStream>();
  /** Insertion order is start order: the queue. */
  private readonly waiting = new Map<string, Waiting>();
  private readonly store: LiveCueStore;
  private readonly now: () => number;

  constructor(private readonly deps: ManagerDeps) {
    this.store = new LiveCueStore(deps.valkey);
    this.now = deps.now ?? Date.now;
  }

  /** Broadcasts with a running worker, and those waiting for a slot (in order). */
  get status(): { active: string[]; queued: string[] } {
    return { active: [...this.streams.keys()], queued: [...this.waiting.keys()] };
  }

  async onStart(session: MediaSessionInfo, start: SessionStart): Promise<void> {
    const { slots } = this.deps;
    // Cheap checks first: a host with captions off never touches the database.
    const hostOff = ineligibility({
      kind: session.kind,
      maxStreams: slots.capacity,
      whisperUrl: this.deps.whisperUrl,
      channelEnabled: true,
      instanceDefault: true,
    });
    if (hostOff) return;
    const id = session.broadcastId;
    if (this.streams.has(id) || this.waiting.has(id)) return;
    const cfg = await loadChannelCaptions(this.deps.db, session.channelId);
    if (!cfg || start.signal.aborted) return;
    const off = ineligibility({
      kind: session.kind,
      maxStreams: slots.capacity,
      whisperUrl: this.deps.whisperUrl,
      channelEnabled: cfg.enabled,
      instanceDefault: cfg.instanceDefault,
    });
    if (off) return;
    await this.deps.db
      .insert(tracks)
      .values({ broadcastId: id, language: cfg.language, status: "queued" })
      .onConflictDoUpdate({
        target: [tracks.broadcastId, tracks.language],
        set: { updatedAt: sql`now()` },
      });
    if (start.signal.aborted || this.streams.has(id) || this.waiting.has(id)) return;
    if (slots.tryAcquire(id)) await this.activate({ session, language: cfg.language });
    else {
      this.waiting.set(id, { session, language: cfg.language });
      // A successor host resuming a track that has no slot here shows it as waiting again.
      await this.deps.db
        .update(tracks)
        .set({ status: "queued", updatedAt: sql`now()` })
        .where(and(eq(tracks.broadcastId, id), eq(tracks.language, cfg.language), eq(tracks.status, "active")));
      this.deps.metrics.queued();
      this.deps.logger.info("captions queued for a slot", { broadcastId: id, position: slots.queuePosition(id) });
    }
  }

  async onEnd(session: MediaSessionInfo, end: SessionEnd): Promise<void> {
    const id = session.broadcastId;
    const stream = this.streams.get(id);
    const language = stream?.language ?? this.waiting.get(id)?.language;
    this.streams.delete(id);
    this.waiting.delete(id);
    this.deps.slots.release(id);
    // The slot goes to the next broadcast first; this one's stitching does not hold it up.
    const promoted = this.promote();
    await stream?.stop();
    if (end.final) await this.finish(session, language);
    await promoted;
  }

  /** Stop every worker (service shutdown); rows and cues stay for a successor. */
  async stopAll(): Promise<void> {
    const all = [...this.streams.values()];
    this.streams.clear();
    for (const s of all) this.deps.slots.release(s.session.broadcastId);
    for (const id of this.waiting.keys()) this.deps.slots.release(id);
    this.waiting.clear();
    await Promise.all(all.map((s) => s.stop()));
  }

  private async promote(): Promise<void> {
    for (const [id, w] of this.waiting) {
      if (!this.deps.slots.tryAcquire(id)) return;
      this.waiting.delete(id);
      await this.activate(w).catch((err: unknown) => {
        this.deps.slots.release(id);
        this.deps.logger.warn("captions failed to start", { broadcastId: id, error: errorCategory(err) });
      });
    }
  }

  private async activate({ session, language }: Waiting): Promise<void> {
    const id = session.broadcastId;
    await this.deps.db
      .update(tracks)
      .set({ status: "active", startedAt: sql`coalesce(${tracks.startedAt}, now())`, updatedAt: sql`now()` })
      .where(
        and(eq(tracks.broadcastId, id), eq(tracks.language, language), inArray(tracks.status, ["queued", "active"])),
      );
    const stream = new CaptionStream(session, language, {
      source: this.deps.source,
      transcriber: this.deps.transcriber,
      store: this.store,
      metrics: this.deps.metrics,
      logger: this.deps.logger.child({ broadcastId: id, worker: "captions" }),
      maskWords: async () => (await loadChannelCaptions(this.deps.db, session.channelId))?.maskWords ?? null,
      backoff: this.deps.backoff,
      now: this.now,
    });
    this.streams.set(id, stream);
    stream.start();
    this.deps.logger.info("captions started", { broadcastId: id });
  }

  /** The broadcast ended: stitch into the VOD, or drop the transcript. Idempotent. */
  private async finish(session: MediaSessionInfo, knownLanguage: string | undefined): Promise<void> {
    const id = session.broadcastId;
    const [row] = await this.deps.db
      .select()
      .from(tracks)
      .where(
        knownLanguage === undefined
          ? eq(tracks.broadcastId, id)
          : and(eq(tracks.broadcastId, id), eq(tracks.language, knownLanguage)),
      )
      .limit(1);
    if (!row || (row.status !== "queued" && row.status !== "active")) return;
    const language = row.language;
    await this.store.deactivate(id);
    const cues = row.status === "active" ? await this.store.all(id, language) : [];
    const vod = session.vodId && cues.length > 0 ? await this.vodPrefix(session.vodId) : null;
    if (!vod) {
      await this.store.drop(id, language);
      await this.setStatus(row.id, { status: "deleted", cueCount: 0 });
      return;
    }
    try {
      const playlist = await this.deps.storage.get(this.deps.bucket, `${vod.prefix}${VOD_PLAYLIST}`);
      const origin = (playlist ? firstProgramDateTime(await playlist.text()) : null) ?? session.startedAt.getTime();
      const doc = vodVttDocument({ originMs: origin, cues: toVodCues(cues, origin) });
      const key = vodCaptionsKey(vod.prefix, language);
      await this.deps.storage.put(this.deps.bucket, key, doc, { contentType: "text/vtt; charset=utf-8" });
      await this.setStatus(row.id, { status: "ready", vodId: vod.id, storageKey: key, cueCount: cues.length });
      await this.store.drop(id, language);
      this.deps.logger.info("captions stitched into the VOD", { broadcastId: id, cues: cues.length });
    } catch (err) {
      // The cues stay in Valkey until their TTL; the VOD plays without captions.
      await this.setStatus(row.id, { status: "failed" });
      this.deps.logger.warn("captions could not be stitched", { broadcastId: id, error: errorCategory(err) });
    }
  }

  private async vodPrefix(vodId: string): Promise<{ id: string; prefix: string } | null> {
    const [v] = await this.deps.db.select({ prefix: vods.storagePrefix }).from(vods).where(eq(vods.id, vodId)).limit(1);
    // Only the VOD's own prefixes: a tampered row must never make this write elsewhere.
    return v && isVodOwnPrefix(vodId, v.prefix) ? { id: vodId, prefix: v.prefix } : null;
  }

  private async setStatus(
    trackId: string,
    set: Partial<Pick<typeof tracks.$inferInsert, "status" | "vodId" | "storageKey" | "cueCount">>,
  ): Promise<void> {
    await this.deps.db
      .update(tracks)
      .set({ ...set, endedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(tracks.id, trackId));
  }
}
