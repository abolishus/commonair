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
import type { T0Outbox } from "./t0-outbox.ts";

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
  /** Resolve VOD/clip T0 work to its source broadcast so it can be tainted and taken offline. */
  resolveBroadcastId: (job: ModerationT0Job) => Promise<string | null>;
  /** True only after the worker's T0 case/action transaction has committed. */
  t0ActionCommitted: (job: ModerationT0Job) => Promise<boolean>;
  logger: Logger;
  metrics: ModerationMetrics;
  /** `MODERATION_SAMPLE_SECONDS`. */
  envSampleSeconds: number;
  t0Outbox: T0Outbox;
  /** Backoff of the live T0 enqueue (retried until it lands). */
  retry?: RetryPolicy;
  /** Attempts before a live T0 enqueue failure is logged `fatal` (it keeps retrying). */
  fatalAfterAttempts?: number;
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
  private readonly recoveryProtected = new Set<string>();
  private readonly committedRecoveryDiscards = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private startupOutbox: Array<{ job: ModerationT0Job; path: string }> | null = null;
  private readonly committedOutbox = new Map<string, { job: ModerationT0Job; path: string }>();
  private pruning: Promise<void> | null = null;
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

  /** T0 broadcasts must be excluded from startup recovery and periodic work-dir sweeps. */
  protectedBroadcastIds(): ReadonlySet<string> {
    return new Set(this.recoveryProtected);
  }

  committedRecoveryBroadcastIds(): ReadonlySet<string> {
    return new Set(this.committedRecoveryDiscards);
  }

  async finishT0Recovery(): Promise<void> {
    for (const { path } of this.committedOutbox.values()) await this.deps.t0Outbox.accepted(path);
    const remaining = await this.deps.t0Outbox.pending();
    const protectedIds = new Set<string>();
    for (const { job } of remaining) {
      const id = await this.sourceBroadcastId(job);
      if (id) protectedIds.add(id);
    }
    for (const id of this.committedRecoveryDiscards) {
      if (!protectedIds.has(id)) this.recoveryProtected.delete(id);
    }
    this.committedOutbox.clear();
    this.committedRecoveryDiscards.clear();
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
    this.recoveryProtected.add(target.broadcastId);
    const persisted = await this.persistUntilStored(
      await this.buildJob("broadcast", target.broadcastId, target.channelId, hit),
      ids,
    );
    // Detach so the sampler can return before stopBroadcast waits for that same sampler to stop.
    // Queueing follows the final recorder poll, so the worker cannot clean objects too early.
    this.detach(this.stopThenEnqueueLiveT0(target, persisted.job));
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

  private async stopThenEnqueueLiveT0(target: LiveTarget, job: ModerationT0Job): Promise<void> {
    const ids = { broadcastId: target.broadcastId, channelId: target.channelId };
    await this.stopBroadcastUntilStopped(target.broadcastId, ids);
    await this.enqueuePersistedT0(job, ids);
  }

  private async stopBroadcastUntilStopped(broadcastId: string, ids: Record<string, string>): Promise<void> {
    const policy = this.deps.retry ?? DEFAULT_RETRY;
    const fatalAfter = this.deps.fatalAfterAttempts ?? 5;
    let delay = policy.initialMs;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.stopBroadcast(broadcastId);
        break;
      } catch (err) {
        const fields = { ...ids, attempt, error: errName(err) };
        if (attempt === fatalAfter) this.log.fatal("T0: local workers still active; retrying before cleanup", fields);
        else this.log.error("T0: stopping local workers failed; retrying", fields);
        await this.sleep(delay);
        delay = Math.min(policy.maxMs, delay * 2);
      }
    }
  }

  private async persistUntilStored(
    job: ModerationT0Job,
    ids: Record<string, string>,
  ): Promise<{ job: ModerationT0Job; path: string }> {
    let delay = (this.deps.retry ?? DEFAULT_RETRY).initialMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.t0Outbox.persist(job);
      } catch (err) {
        this.log.fatal("T0 evidence could not be persisted; retaining it in memory and retrying", {
          ...ids,
          attempt,
          error: errName(err),
        });
        await this.sleep(delay);
        delay = Math.min((this.deps.retry ?? DEFAULT_RETRY).maxMs, delay * 2);
      }
    }
  }

  /** Load and taint durable T0 work before crash recovery can publish local recording segments. */
  async prepareT0Replay(): Promise<Set<string>> {
    this.startupOutbox ??= await this.deps.t0Outbox.pending();
    const broadcasts = new Set<string>();
    for (const id of this.committedRecoveryDiscards) broadcasts.add(id);
    const quiesced = new Set<string>();
    const uncommitted: Array<{ job: ModerationT0Job; path: string }> = [];
    for (const record of this.startupOutbox) {
      const { job } = record;
      const broadcastId = await this.sourceBroadcastId(job);
      if (broadcastId) {
        this.taintedBroadcasts.add(broadcastId);
        this.taintedChannels.add(job.channelId);
        broadcasts.add(broadcastId);
        if (!quiesced.has(broadcastId)) {
          await this.stopBroadcastUntilStopped(broadcastId, this.jobIds(job));
          quiesced.add(broadcastId);
        }
      }
      if (await this.t0ActionCommitted(job)) {
        this.committedOutbox.set(`${job.subjectType}:${job.subjectId}`, record);
        if (broadcastId) this.committedRecoveryDiscards.add(broadcastId);
        continue;
      }
      uncommitted.push(record);
      if (broadcastId) this.recoveryProtected.add(broadcastId);
    }
    this.startupOutbox = uncommitted;
    return broadcasts;
  }

  /** Re-enqueue sealed T0 jobs after local recovery has skipped all tainted broadcasts. */
  async replayT0Outbox(): Promise<void> {
    await this.prepareT0Replay();
    const records = this.startupOutbox ?? [];
    for (const { job, path } of records) {
      const ids = this.jobIds(job);
      const broadcastId = await this.sourceBroadcastId(job);
      if (await this.t0ActionCommitted(job)) {
        this.committedOutbox.set(`${job.subjectType}:${job.subjectId}`, { job, path });
        if (broadcastId) {
          this.committedRecoveryDiscards.add(broadcastId);
          this.recoveryProtected.add(broadcastId);
        }
        continue;
      }
      if (broadcastId) {
        await this.stopBroadcastUntilStopped(broadcastId, ids);
        this.recoveryProtected.add(broadcastId);
      }
      this.detach(this.enqueuePersistedT0(job, ids));
    }
    this.startupOutbox = null;
  }

  /** Retire acknowledged records during the periodic serialized work-dir sweep. */
  async pruneCommittedT0Outbox(): Promise<void> {
    if (this.pruning) return this.pruning;
    this.pruning = (async () => {
      const records = await this.deps.t0Outbox.pending();
      const stillProtected = new Set<string>();
      for (const { job, path } of records) {
        const broadcastId = await this.sourceBroadcastId(job);
        if (await this.t0ActionCommitted(job)) {
          this.committedOutbox.set(`${job.subjectType}:${job.subjectId}`, { job, path });
          if (broadcastId) {
            this.committedRecoveryDiscards.add(broadcastId);
            this.recoveryProtected.add(broadcastId);
          }
        } else if (broadcastId) {
          stillProtected.add(broadcastId);
        }
      }
      for (const id of this.recoveryProtected)
        if (!stillProtected.has(id) && !this.committedRecoveryDiscards.has(id)) this.recoveryProtected.delete(id);
      for (const id of stillProtected) this.recoveryProtected.add(id);
    })().finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }

  private async sourceBroadcastId(job: ModerationT0Job): Promise<string | null> {
    if (job.subjectType === "broadcast") return job.subjectId;
    const ids = this.jobIds(job);
    const policy = this.deps.retry ?? DEFAULT_RETRY;
    const fatalAfter = this.deps.fatalAfterAttempts ?? 5;
    let delay = policy.initialMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.resolveBroadcastId(job);
      } catch (err) {
        const fields = { ...ids, attempt, error: errName(err) };
        if (attempt === fatalAfter) this.log.fatal("T0 source lookup failed; retrying before admission", fields);
        else this.log.error("T0 source lookup failed; retrying", fields);
        await this.sleep(delay);
        delay = Math.min(policy.maxMs, delay * 2);
      }
    }
  }

  private async t0ActionCommitted(job: ModerationT0Job): Promise<boolean> {
    const ids = this.jobIds(job);
    const policy = this.deps.retry ?? DEFAULT_RETRY;
    const fatalAfter = this.deps.fatalAfterAttempts ?? 5;
    let delay = policy.initialMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.t0ActionCommitted(job);
      } catch (err) {
        const fields = { ...ids, attempt, error: errName(err) };
        if (attempt === fatalAfter) this.log.fatal("T0 action lookup failed; retaining evidence and retrying", fields);
        else this.log.error("T0 action lookup failed; retrying", fields);
        await this.sleep(delay);
        delay = Math.min(policy.maxMs, delay * 2);
      }
    }
  }

  private jobIds(job: ModerationT0Job): Record<string, string> {
    return job.subjectType === "broadcast"
      ? { broadcastId: job.subjectId, channelId: job.channelId }
      : { subjectType: job.subjectType, subjectId: job.subjectId, channelId: job.channelId };
  }

  private async enqueuePersistedT0(job: ModerationT0Job, ids: Record<string, string>): Promise<void> {
    const policy = this.deps.retry ?? DEFAULT_RETRY;
    const fatalAfter = this.deps.fatalAfterAttempts ?? 5;
    let delay = policy.initialMs;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.queue.addT0(job);
        if (job.subjectType !== "upload") this.deps.metrics.t0(job.subjectType);
        this.log.error("T0 job enqueued", { ...ids, attempt });
        return;
      } catch (err) {
        this.deps.metrics.t0EnqueueFailed();
        const fields = { ...ids, attempt, error: errName(err) };
        if (attempt === fatalAfter) this.log.fatal("T0 enqueue keeps failing; retrying until accepted", fields);
        else this.log.error("T0 enqueue failed; retrying", fields);
        await this.sleep(delay);
        delay = Math.min(policy.maxMs, delay * 2);
      }
    }
  }

  /** T0 found before a VOD or clip is published: persist sealed evidence and retry until accepted. */
  async t0Prepublish(subjectType: "vod" | "clip", subjectId: string, channelId: string, hit: Hit): Promise<void> {
    const ids = { subjectType, subjectId, channelId };
    this.log.error("T0 hash match before publishing; not publishing", { ...ids, ...this.matchFields(hit.match) });
    const job = await this.buildJob(subjectType, subjectId, channelId, hit);
    const broadcastId = await this.sourceBroadcastId(job);
    if (broadcastId) {
      this.taintedBroadcasts.add(broadcastId);
      this.taintedChannels.add(channelId);
      this.recoveryProtected.add(broadcastId);
    }
    const persisted = await this.persistUntilStored(job, ids);
    if (broadcastId) {
      await this.stopBroadcastUntilStopped(broadcastId, ids);
    }
    await this.enqueuePersistedT0(persisted.job, ids);
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

  /** Graceful shutdown waits until every known T0 is accepted by the queue. */
  async stop(): Promise<void> {
    await this.settle();
  }
}
