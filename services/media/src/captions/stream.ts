// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One broadcast's live captions: audio chunks in, masked cues out to Valkey. The reader and the
 * transcriber are decoupled by a short queue, so a slow whisper never backs up the audio reader:
 * past `MAX_PENDING` chunks the oldest waiting one is skipped. A failed or slow whisper call drops
 * its chunk and backs off (later chunks are skipped until the backoff passes); the stream keeps its
 * slot and keeps publishing `throughMs`, so the subtitle playlist moves on with empty segments.
 */
import { buildCues, type Cue, type LiveTrack } from "@commonair/captions";
import type { Logger } from "@commonair/observability";
import type { MediaSessionInfo } from "../hooks.ts";
import { createMasker, type Masker } from "./mask.ts";
import type { CaptionsMetrics, DropReason } from "./metrics.ts";
import type { AudioChunk, AudioSource } from "./source.ts";
import type { LiveCueStore } from "./store.ts";
import { WhisperError, type Transcriber } from "./whisper.ts";

/** Chunks waiting for whisper beyond this are skipped, oldest first (each is 3 s of audio). */
export const MAX_PENDING = 2;
/** How often the mask list is re-read, so a studio change applies mid-stream. */
export const MASK_REFRESH_MS = 30_000;

/** What the stream needs of the cue store (`LiveCueStore`; tests pass a fake). */
export type CueSink = Pick<LiveCueStore, "track" | "all" | "append">;

export interface StreamDeps {
  source: AudioSource;
  transcriber: Transcriber;
  store: CueSink;
  metrics: CaptionsMetrics;
  logger: Logger;
  /** The channel's current mask list (null keeps the last one). */
  maskWords: () => Promise<string[] | null>;
  backoff?: { initialMs: number; maxMs: number };
  now?: () => number;
}

interface Pending {
  chunk: AudioChunk;
  skip: DropReason | null;
}

export class CaptionStream {
  private readonly abort = new AbortController();
  private running: Promise<void> | null = null;
  private readonly pending: Pending[] = [];
  private wake: (() => void) | null = null;
  private readerDone = false;
  private track: LiveTrack | null = null;
  private previous: Cue | null = null;
  private nextN = 0;
  /** Null until the mask list has been read once: no cue is stored before it can be masked. */
  private masker: Masker | null = null;
  private maskLoadedAt = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private backoffUntil = 0;
  private readonly now: () => number;

  constructor(
    readonly session: MediaSessionInfo,
    readonly language: string,
    private readonly deps: StreamDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.running ??= this.run().catch((err: unknown) => {
      this.deps.logger.error("captions stream failed", { error: err instanceof Error ? err.name : "unknown" });
    });
  }

  /** Stops reading and transcribing; resolves once nothing more will be written. */
  async stop(): Promise<void> {
    this.abort.abort();
    this.wake?.();
    await this.running;
  }

  private async run(): Promise<void> {
    const resumed = await this.deps.store.track(this.session.broadcastId);
    if (resumed && resumed.language === this.language) {
      // A successor host (or a restarted stream) carries on the same segment grid and cue numbering.
      this.track = resumed;
      const cues = await this.deps.store.all(this.session.broadcastId, this.language);
      this.previous = cues.at(-1) ?? null;
      this.nextN = cues.length;
    }
    await Promise.all([this.read(), this.process()]);
  }

  private async read(): Promise<void> {
    try {
      for await (const chunk of this.deps.source(this.session, this.abort.signal)) {
        if (this.abort.signal.aborted) break;
        this.pending.push({ chunk, skip: null });
        const waiting = this.pending.filter((p) => p.skip === null);
        if (waiting.length > MAX_PENDING) {
          const oldest = waiting[0];
          if (oldest) oldest.skip = "backlog";
        }
        this.wake?.();
      }
    } finally {
      this.readerDone = true;
      this.wake?.();
    }
  }

  private async process(): Promise<void> {
    for (;;) {
      const next = this.pending.shift();
      if (!next) {
        if (this.readerDone || this.abort.signal.aborted) return;
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
        continue;
      }
      if (this.abort.signal.aborted) return;
      await this.handle(next);
    }
  }

  private async handle({ chunk, skip }: Pending): Promise<void> {
    let reason: DropReason | null = skip;
    let cues: Cue[] = [];
    if (reason === null && this.now() < this.backoffUntil) reason = "backoff";
    if (reason === null) {
      const started = this.now();
      try {
        const segments = await this.deps.transcriber.transcribe(chunk.wav, this.language, this.abort.signal);
        this.deps.metrics.latency(this.now() - started);
        this.failures = 0;
        const masker = await this.refreshMask();
        if (masker === null) reason = "mask";
        else
          cues = buildCues(chunk, segments, this.previous)
            .map((c) => ({ ...c, text: masker.mask(c.text) }))
            .filter((c) => c.text !== "");
      } catch (err) {
        if (this.abort.signal.aborted) return;
        reason = err instanceof WhisperError ? err.kind : "unavailable";
        const { initialMs, maxMs } = this.deps.backoff ?? { initialMs: 1_000, maxMs: 30_000 };
        this.backoffUntil = this.now() + Math.min(maxMs, initialMs * 2 ** Math.min(this.failures, 10));
        this.failures++;
      }
    }
    if (this.abort.signal.aborted) return;
    const track: LiveTrack = {
      language: this.language,
      w0Ms: this.track?.w0Ms ?? this.w0Of(chunk),
      anchorMs: this.track?.anchorMs ?? chunk.startMs,
      throughMs: Math.max(this.track?.throughMs ?? 0, chunk.endMs),
    };
    try {
      await this.deps.store.append(this.session.broadcastId, track, cues, this.nextN);
      this.track = track;
      this.nextN += cues.length;
      this.previous = cues.at(-1) ?? this.previous;
    } catch {
      reason ??= "store";
      cues = [];
    }
    if (reason === null) this.deps.metrics.chunk();
    else this.deps.metrics.dropped(reason);
  }

  /**
   * The timeline origin for `X-TIMESTAMP-MAP`. The source carries it per chunk (`w0Ms`); a
   * source without it falls back to the broadcast start, which keeps cue order and PDT intact.
   */
  private w0Of(chunk: AudioChunk): number {
    return chunk.w0Ms ?? this.session.startedAt.getTime();
  }

  private async refreshMask(): Promise<Masker | null> {
    if (this.masker !== null && this.now() - this.maskLoadedAt < MASK_REFRESH_MS) return this.masker;
    try {
      const words = await this.deps.maskWords();
      if (words) {
        this.masker = createMasker(words);
        this.maskLoadedAt = this.now();
      }
    } catch {
      // Keep the last list: a database blip must not unmask anything.
    }
    return this.masker;
  }

  /** For tests and logs. */
  get state(): { throughMs: number | null; cues: number } {
    return { throughMs: this.track?.throughMs ?? null, cues: this.nextN };
  }
}
