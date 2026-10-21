// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media's half of automated moderation (ADR 0006, docs/testing/e4c-selectors.md "Sampling",
 * "T0 live", "T0 VOD/clip"). Media runs PDQ on every sampled frame, thumbnail and pre-publish
 * VOD/clip frame and matches it against the hash lists. On a live match it **kicks the publisher
 * first**, then seals the matched frame to the evidence public key and enqueues `moderation.t0`
 * (retried until it lands). The worker owns every T0 database action; media writes no moderation
 * table. Unmatched live frames go to the classifier through Valkey (TTL) and a `scan` job.
 *
 * Nothing here can switch matching off: there is no provider without PDQ, the backlog rule only
 * drops classifier jobs, and every list failure at startup refuses to start.
 * Logs carry ids, categories, providers, list versions, distances and qualities only.
 */
import { and, count, eq, isNull, ne } from "drizzle-orm";
import type { HashListCategory } from "@commonair/contracts/enums";
import { KEYS, type ModerationT0Job, type SealedEvidence } from "@commonair/contracts/internal";
import { schema, uuidv7, type Database } from "@commonair/db";
import {
  effectiveSampleSeconds,
  MODERATION_CONSTANTS,
  parseThresholds,
  plaintextSha256,
  type DecodedFrame,
  type HashMatch,
  type HashMatcher,
  type PdqHash,
  type SealingKey,
} from "@commonair/moderation";
import type { Logger } from "@commonair/observability";
import type { ModerationMetrics } from "./metrics.ts";
import type { ModerationQueue } from "./queue.ts";
import type { FrameTools } from "./tools.ts";
import { errorCategory } from "./logging.ts";

/** `channels.suspended_reason` / `vods|clips.removed_reason` the worker writes for a T0 match. */
export const T0_REASON = "t0_hash_match";
const SETTING_KEY = "moderation.thresholds";

export interface LiveTarget {
  broadcastId: string;
  channelId: string;
  /** MediaMTX path, `live/<slug>`. */
  path: string;
}

/** A frame that matched a list, with what the T0 job needs. */
export interface Hit {
  match: HashMatch;
  frame: DecodedFrame;
  pdq: PdqHash;
  capturedAt: Date;
  /** The original image (a thumbnail) sealed alongside the decoded frame. */
  original?: { bytes: Uint8Array; contentType: SealedEvidence["contentType"] };
}

export interface RetryPolicy {
  initialMs: number;
  maxMs: number;
}

export interface ModerationDeps {
  db: Database;
  /** Command connection; the RGB frame for the classifier goes here with a TTL. */
  valkey: { set(key: string, value: Buffer, mode: "EX", seconds: number): Promise<unknown> };
  queue: ModerationQueue;
  matcher: HashMatcher;
  sealer: SealingKey;
  tools: FrameTools;
  /** Resolves after MediaMTX confirms the publisher is disconnected (false means already absent). */
  kickPublisher: (path: string) => Promise<void | boolean>;
  /** Stop local workers for a broadcast without finalizing (publishing) its VOD. */
  stopBroadcast: (broadcastId: string) => Promise<void>;
  logger: Logger;
  metrics: ModerationMetrics;
  /** `MODERATION_SAMPLE_SECONDS`. */
  envSampleSeconds: number;
  /** Backoff of the live T0 enqueue (retried until it lands). */
  retry?: RetryPolicy;
  /** Attempts before a live T0 enqueue failure is logged `fatal` (it keeps retrying). */
  fatalAfterAttempts?: number;
  /** Attempts for a pre-publish T0 enqueue before the job fails (BullMQ retries the job). */
  prepublishAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const DEFAULT_RETRY: RetryPolicy = { initialMs: 250, maxMs: 15_000 };
const SETTING_CACHE_MS = 1_000;
const WAITING_CACHE_MS = 1_000;
const LIVE_COUNT_CACHE_MS = 10_000;
const DROP_WARN_EVERY_MS = 60_000;
const { PDQ_MIN_QUALITY, CLASSIFIER_BACKLOG_INTERVALS, FRAME_TTL_SECONDS, EVIDENCE_INLINE_MAX_BYTES } =
  MODERATION_CONSTANTS;

const errName = errorCategory;

export class MediaModeration {
  /** Broadcasts, channels and paths with a T0 match in this process, known before the worker's transaction lands. */
  private readonly taintedBroadcasts = new Set<string>();
  private readonly taintedChannels = new Set<string>();
  private readonly taintedPaths = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;
  private readonly log: Logger;
  private setting: { seconds: number; at: number } | null = null;
  private waiting: { n: number; at: number } | null = null;
  private live: { n: number; at: number } | null = null;
  private lastDropWarn = 0;

  constructor(private readonly deps: ModerationDeps) {
    this.log = deps.logger.child({ component: "moderation" });
  }

  get matcher(): HashMatcher {
    return this.deps.matcher;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : Bun.sleep(ms);
  }

  // Sample interval -------------------------------------------------------------------------

  /**
   * The effective live interval: min(env, governance setting), re-read at most once a second.
   * An unreadable setting keeps the last value (or the env value); an invalid one means the
   * defaults (`parseThresholds` fails closed), never "off".
   */
  async sampleSeconds(): Promise<number> {
    const t = this.now().getTime();
    if (this.setting && t - this.setting.at < SETTING_CACHE_MS) return this.setting.seconds;
    try {
      const [row] = await this.deps.db
        .select({ value: schema.governanceSettings.value })
        .from(schema.governanceSettings)
        .where(eq(schema.governanceSettings.key, SETTING_KEY));
      const { thresholds, valid } = parseThresholds(row?.value);
      if (row && !valid) this.log.warn("moderation.thresholds is invalid; using the defaults");
      const seconds = effectiveSampleSeconds(this.deps.envSampleSeconds, thresholds);
      this.setting = { seconds, at: t };
      return seconds;
    } catch (err) {
      this.log.warn("could not read moderation.thresholds; keeping the last interval", { error: errName(err) });
      return this.setting?.seconds ?? this.deps.envSampleSeconds;
    }
  }

  // Taint ---------------------------------------------------------------------------------

  private taint(t: LiveTarget): void {
    this.taintedBroadcasts.add(t.broadcastId);
    this.taintedChannels.add(t.channelId);
    this.taintedPaths.add(t.path);
  }

  /** A channel or path with a T0 match here: a reconnect is kicked before any work starts. */
  isLiveTainted(channelId: string, path: string): boolean {
    return this.taintedChannels.has(channelId) || this.taintedPaths.has(path);
  }

  /**
   * Nothing from this broadcast may be published: a match in this process, a T0 suspension or
   * open T0 case in the database, or a T0 job still on the queue (the worker has not landed it).
   */
  async broadcastTainted(broadcastId: string): Promise<boolean> {
    if (this.taintedBroadcasts.has(broadcastId)) return true;
    const b = schema.broadcasts;
    const c = schema.channels;
    const [suspended] = await this.deps.db
      .select({ id: b.id })
      .from(b)
      .innerJoin(c, eq(c.id, b.channelId))
      .where(and(eq(b.id, broadcastId), eq(c.suspendedReason, T0_REASON)))
      .limit(1);
    if (suspended) return true;
    const mc = schema.moderationCases;
    const [kase] = await this.deps.db
      .select({ id: mc.id })
      .from(mc)
      .where(
        and(
          eq(mc.subjectType, "broadcast"),
          eq(mc.subjectId, broadcastId),
          eq(mc.tier, "t0"),
          ne(mc.status, "dismissed"),
        ),
      )
      .limit(1);
    if (kase) return true;
    return this.deps.queue.hasT0("broadcast", broadcastId);
  }

  /** Keep retrying until the publisher is confirmed off air; fail closed while MediaMTX is unavailable. */
  async kick(path: string, ids: Record<string, string>): Promise<void> {
    let delay = 200;
    const fatalAfter = this.deps.fatalAfterAttempts ?? 5;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.kickPublisher(path);
        return;
      } catch (err) {
        const fields = { ...ids, attempt, error: errName(err) };
        if (attempt >= fatalAfter)
          this.log.fatal("T0: publisher remains live; retrying kick until confirmed off air", fields);
        else this.log.error("T0: kicking the publisher failed; retrying", fields);
        await this.sleep(delay);
        delay = Math.min((this.deps.retry ?? DEFAULT_RETRY).maxMs, delay * 2);
      }
    }
  }

  /** Decode a still image to both moderation sizes. */
  decode(bytes: Uint8Array): Promise<DecodedFrame> {
    return this.deps.tools.decodeImage(bytes);
  }

  captureFailed(): void {
    this.deps.metrics.captureFailed();
  }

  prepublishFrames(subject: "vod" | "clip", n: number): void {
    this.deps.metrics.prepublishFrames(subject, n);
  }

  // Matching ------------------------------------------------------------------------------

  /** PDQ + match. Frames below PDQ_MIN_QUALITY are never matched. */
  matchFrame(frame: DecodedFrame): { pdq: PdqHash; match: HashMatch | null } {
    const pdq = this.deps.tools.pdq(frame.luma);
    if (pdq.quality < PDQ_MIN_QUALITY) return { pdq, match: null };
    return { pdq, match: this.deps.matcher.match(pdq) };
  }

  /**
   * One sampled live frame: PDQ and match here; a match is T0 live; otherwise the RGB frame goes
   * to the classifier (unless the queue is backed up, which drops the classifier job only).
   */
  async scanLiveFrame(target: LiveTarget, frame: DecodedFrame, capturedAt: Date): Promise<"clean" | "matched"> {
    const { metrics } = this.deps;
    metrics.frame("sampled");
    const { pdq, match } = this.matchFrame(frame);
    if (pdq.quality < PDQ_MIN_QUALITY) metrics.frame("low_quality");
    if (match) {
      await this.t0Live(target, { match, frame, pdq, capturedAt });
      return "matched";
    }
    if (await this.backedUp()) {
      metrics.classifierDropped();
      const t = this.now().getTime();
      if (t - this.lastDropWarn >= DROP_WARN_EVERY_MS) {
        this.lastDropWarn = t;
        this.log.warn("moderation queue backed up; dropping classifier frames (PDQ still runs)", {
          broadcastId: target.broadcastId,
        });
      }
      return "clean";
    }
    const frameId = uuidv7();
    try {
      await this.deps.valkey.set(KEYS.moderationFrame(frameId), Buffer.from(frame.rgb), "EX", FRAME_TTL_SECONDS);
      await this.deps.queue.addScan({
        frameId,
        broadcastId: target.broadcastId,
        channelId: target.channelId,
        capturedAt: capturedAt.toISOString(),
        pdq: pdq.quality >= PDQ_MIN_QUALITY ? pdq.hash : null,
        quality: pdq.quality,
      });
      metrics.frame("enqueued");
    } catch (err) {
      metrics.scanEnqueueFailed();
      this.log.warn("could not enqueue a classifier frame", { broadcastId: target.broadcastId, error: errName(err) });
    }
    return "clean";
  }

  /** The waiting count is above CLASSIFIER_BACKLOG_INTERVALS frames per live broadcast. */
  private async backedUp(): Promise<boolean> {
    try {
      const t = this.now().getTime();
      if (!this.waiting || t - this.waiting.at >= WAITING_CACHE_MS)
        this.waiting = { n: await this.deps.queue.waitingCount(), at: t };
      if (!this.live || t - this.live.at >= LIVE_COUNT_CACHE_MS) {
        const [row] = await this.deps.db
          .select({ n: count() })
          .from(schema.broadcasts)
          .where(isNull(schema.broadcasts.endedAt));
        this.live = { n: row?.n ?? 0, at: t };
      }
      return this.waiting.n > CLASSIFIER_BACKLOG_INTERVALS * Math.max(1, this.live.n);
    } catch {
      // Unknown backlog: try to enqueue (a failure is counted there).
      return false;
    }
  }

  /** PDQ-check a still image (live or VOD/clip thumbnail). Decoding failures throw (fail closed). */
  async checkImage(bytes: Uint8Array): Promise<{ frame: DecodedFrame; pdq: PdqHash; match: HashMatch | null }> {
    const frame = await this.deps.tools.decodeImage(bytes);
    return { frame, ...this.matchFrame(frame) };
  }

  /**
   * A live thumbnail before it is written: a match is handled as T0 live and nothing is written.
   * Returns true on a match.
   */
  async checkLiveThumbnail(
    target: LiveTarget,
    bytes: Uint8Array,
    contentType: SealedEvidence["contentType"],
  ): Promise<boolean> {
    const capturedAt = this.now();
    const { frame, pdq, match } = await this.checkImage(bytes);
    if (!match) return false;
    await this.t0Live(target, { match, frame, pdq, capturedAt, original: { bytes, contentType } });
    return true;
  }

  /**
   * PDQ on every frame of a local video file sampled `everySeconds` apart (all of them, before
   * publishing). Returns the first match or null. A decoder error throws: the caller must not
   * publish (fail closed).
   */
  async scanVideoFile(
    input: string,
    everySeconds: number,
    capturedAt: Date,
  ): Promise<{ hit: Hit | null; frames: number }> {
    let frames = 0;
    for await (const frame of this.deps.tools.sampleVideo(input, everySeconds)) {
      frames++;
      const { pdq, match } = this.matchFrame(frame);
      if (match) return { hit: { match, frame, pdq, capturedAt }, frames };
    }
    return { hit: null, frames };
  }

  // T0 ------------------------------------------------------------------------------------

  private matchFields(m: HashMatch) {
    return {
      category: m.category,
      provider: m.provider,
      listVersion: m.listVersion,
      distance: m.distance,
      quality: m.quality,
    };
  }

  /**
   * T0 on a live broadcast: (1) taint and kick the publisher, (2) stop local workers without
   * publishing the VOD, (3) seal the frame and enqueue `t0`, retried until it lands. Steps 2–3
   * run detached because the caller is often one of the broadcast's own workers.
   */
  async t0Live(target: LiveTarget, hit: Hit): Promise<void> {
    const ids = { broadcastId: target.broadcastId, channelId: target.channelId };
    this.taint(target);
    this.deps.metrics.frame("matched");
    this.log.error("T0 hash match on a live broadcast; ending it", { ...ids, ...this.matchFields(hit.match) });
    await this.kick(target.path, ids);
    this.detach(
      this.deps.stopBroadcast(target.broadcastId).catch((err: unknown) => {
        this.log.error("T0: stopping local workers failed", { ...ids, error: errName(err) });
      }),
    );
    this.detach(this.enqueueLiveT0(target, hit));
  }

  /** Kick a reconnect of a tainted channel before any work starts (the worker suspends it meanwhile). */
  refuseReconnect(target: LiveTarget): void {
    this.taint(target);
    this.log.warn("T0: refusing a reconnect of a matched channel", {
      broadcastId: target.broadcastId,
      channelId: target.channelId,
    });
    this.detach(this.kick(target.path, { broadcastId: target.broadcastId, channelId: target.channelId }));
  }

  private async enqueueLiveT0(target: LiveTarget, hit: Hit): Promise<void> {
    const ids = { broadcastId: target.broadcastId, channelId: target.channelId };
    const policy = this.deps.retry ?? DEFAULT_RETRY;
    const fatalAfter = this.deps.fatalAfterAttempts ?? 5;
    let job: ModerationT0Job | null = null;
    let delay = policy.initialMs;
    for (let attempt = 1; ; attempt++) {
      try {
        job ??= await this.buildJob("broadcast", target.broadcastId, target.channelId, hit);
        await this.deps.queue.addT0(job);
        this.deps.metrics.t0("broadcast");
        this.log.error("T0 job enqueued", { ...ids, attempt });
        return;
      } catch (err) {
        this.deps.metrics.t0EnqueueFailed();
        const fields = { ...ids, attempt, error: errName(err) };
        if (attempt === fatalAfter)
          this.log.fatal("T0: enqueue keeps failing; the stream is off air, retrying until it lands", fields);
        else this.log.error("T0: enqueue failed; retrying", fields);
        if (this.stopped) {
          this.log.fatal("T0: enqueue abandoned at shutdown; operator action required", ids);
          return;
        }
        await this.sleep(delay);
        delay = Math.min(policy.maxMs, delay * 2);
      }
    }
  }

  /**
   * T0 found before a VOD or clip is published: seal and enqueue (a few attempts; a failure
   * throws so the job is retried and nothing is published).
   */
  async t0Prepublish(subjectType: "vod" | "clip", subjectId: string, channelId: string, hit: Hit): Promise<void> {
    const ids = { subjectType, subjectId, channelId };
    this.log.error("T0 hash match before publishing; not publishing", { ...ids, ...this.matchFields(hit.match) });
    const job = await this.buildJob(subjectType, subjectId, channelId, hit);
    const attempts = this.deps.prepublishAttempts ?? 5;
    let delay = (this.deps.retry ?? DEFAULT_RETRY).initialMs;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.queue.addT0(job);
        this.deps.metrics.t0(subjectType);
        return;
      } catch (err) {
        this.deps.metrics.t0EnqueueFailed();
        this.log.error("T0: enqueue failed", { ...ids, attempt, error: errName(err) });
        if (attempt >= attempts) throw new Error("T0 enqueue failed", { cause: err });
        await this.sleep(delay);
        delay = Math.min((this.deps.retry ?? DEFAULT_RETRY).maxMs, delay * 2);
      }
    }
  }

  private async buildJob(
    subjectType: ModerationT0Job["subjectType"],
    subjectId: string,
    channelId: string,
    hit: Hit,
  ): Promise<ModerationT0Job> {
    return {
      subjectType,
      subjectId,
      channelId,
      userId: null,
      listCategory: hit.match.category satisfies HashListCategory,
      provider: hit.match.provider,
      listVersion: hit.match.listVersion,
      distance: hit.match.distance,
      quality: hit.match.quality,
      capturedAt: hit.capturedAt.toISOString(),
      evidence: await this.sealHit(hit),
    };
  }

  /** The matched frame as PNG (luma with its PDQ, and RGB), plus the original image if any. */
  async sealHit(hit: Hit): Promise<SealedEvidence[]> {
    const png = await this.deps.tools.encodePng(hit.frame);
    const capturedAt = hit.capturedAt.toISOString();
    const items: {
      bytes: Uint8Array;
      kind: SealedEvidence["kind"];
      contentType: SealedEvidence["contentType"];
      pdq: PdqHash | null;
    }[] = [
      // The PDQ goes on the luma object only, so a confirm adds the hash to the block list once.
      { bytes: png.luma, kind: "frame", contentType: "image/png", pdq: hit.pdq },
      { bytes: png.rgb, kind: "frame", contentType: "image/png", pdq: null },
    ];
    if (hit.original && hit.original.bytes.byteLength <= EVIDENCE_INLINE_MAX_BYTES)
      items.push({ bytes: hit.original.bytes, kind: "thumbnail", contentType: hit.original.contentType, pdq: null });
    const out: SealedEvidence[] = [];
    for (const it of items) {
      if (it.bytes.byteLength > EVIDENCE_INLINE_MAX_BYTES) continue;
      const sealed = await this.deps.sealer.seal(it.bytes);
      out.push({
        kind: it.kind,
        contentType: it.contentType,
        sealedBase64: Buffer.from(sealed).toString("base64"),
        sha256: await plaintextSha256(it.bytes),
        sizeBytes: it.bytes.byteLength,
        keyId: this.deps.sealer.keyId,
        pdq: it.pdq?.hash ?? null,
        pdqQuality: it.pdq ? Math.round(it.pdq.quality) : null,
        capturedAt,
      });
    }
    if (out.length === 0) throw new Error("no evidence object fits inline");
    return out;
  }

  // Lifecycle -----------------------------------------------------------------------------

  private detach(p: Promise<unknown>): void {
    const tracked = p.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Wait for detached T0 work (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(this.pending);
  }

  /** Stop retrying at shutdown (a pending live T0 enqueue logs `fatal`). */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.settle();
  }
}
