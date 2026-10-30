// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The verified-watch gate and surge guard reader (ADR 0015). The integrity worker writes one
 * `KEYS.verifiedWatch` per watching user and the surge guard one `KEYS.surgeOverride` per channel;
 * this reads both with short in-process caches and hands `rules.ts` a pure `WatchGateState`.
 * Every failure fails open: a Valkey error lets the message through (decision 1).
 */
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { KEYS, SurgeOverride, VerifiedWatchValue, WATCH_GATE_ATTEMPTS } from "@commonair/contracts/internal";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { TtlCache } from "./cache.ts";
import { errorFields } from "./errors.ts";
import type { Limiter } from "./limiter.ts";
import type { Metrics } from "./metrics.ts";
import type { ChannelState, Rejection, WatchGateState } from "./types.ts";

export interface WatchGateDeps {
  valkey: ValkeyClient;
  db: Database;
  limiter: Limiter;
  metrics: Metrics;
  logger: Logger;
  enabled: { watchGate: boolean; surgeGuard: boolean };
  /** Cache lifetimes (tests shorten them). */
  ttlMs?: { override?: number; verified?: number; thresholds?: number; exempt?: number };
  clock?: () => number;
}

export type SurgeFrameState = { state: "off" | "on" | "suppressed"; until: string | null };

/** The gate surge mode applies (decision 6: `max(minVerifiedWatchSeconds, 60)`). */
export const SURGE_GATE_SECONDS = 60;
/** ADR 0015 decision 5's default, used when the governance setting cannot be read. */
export const DEFAULT_FALLBACK_ACCOUNT_AGE_DAYS = 7;
const WARN_EVERY_MS = 60_000;
const ATTEMPT_WINDOW_MS = 60_000;

const Thresholds = z.object({
  gateFallbackAccountAgeDays: z.number().int().min(0).default(DEFAULT_FALLBACK_ACCOUNT_AGE_DAYS),
});

/** Parse a stored JSON value; anything malformed reads as absent (the writer's schema is the contract). */
function parseJson<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const RATE_LIMITED: Rejection = { code: "msg_ratelimit", text: "You are sending messages too quickly." };

export class WatchGate {
  private readonly overrides: TtlCache<string, SurgeOverride | null>;
  private readonly verified: TtlCache<string, VerifiedWatchValue | null>;
  private readonly thresholds: TtlCache<"t", number>;
  private readonly exempt: TtlCache<string, boolean>;
  private readonly clock: () => number;
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: WatchGateDeps) {
    this.clock = d.clock ?? Date.now;
    this.overrides = new TtlCache(d.ttlMs?.override ?? 3_000, 50_000, this.clock);
    this.verified = new TtlCache(d.ttlMs?.verified ?? 5_000, 200_000, this.clock);
    this.thresholds = new TtlCache(d.ttlMs?.thresholds ?? 60_000, 1, this.clock);
    // Keyed by the surge's `since`, so a new surge asks again; the answer cannot change within one.
    this.exempt = new TtlCache(d.ttlMs?.exempt ?? 30 * 60_000, 200_000, this.clock);
  }

  /** The gate state for one sender; null when neither the gate nor surge mode applies to the channel. */
  async load(channel: ChannelState, userId: string, _now: Date): Promise<WatchGateState | null> {
    const { watchGate, surgeGuard } = this.d.enabled;
    if (!watchGate && !surgeGuard) return null;
    // No live broadcast, nothing to have watched: fail toward letting people talk.
    const broadcastId = channel.liveBroadcastId;
    if (!broadcastId) return null;
    // A channel's saved gate is ignored while the instance flag is off.
    const own = watchGate ? channel.settings.minVerifiedWatchSeconds : 0;
    const guarded = surgeGuard && channel.settings.surgeGuard.enabled;
    if (own === 0 && !guarded) return null;

    let override: SurgeOverride | null = null;
    if (guarded) {
      try {
        override = await this.readOverride(channel.id);
      } catch (err) {
        return own > 0 ? this.unavailable(own, err) : this.failOpen(err);
      }
    }
    const surgeOn = override?.state === "on";
    const fromSurge = surgeOn && SURGE_GATE_SECONDS > own;
    let required = Math.max(own, surgeOn ? SURGE_GATE_SECONDS : 0);
    if (required === 0) return null;

    // Earlier chatters are unaffected by surge mode (decision 6); the channel's own gate still applies.
    let surgeExempt = false;
    if (fromSurge && override) {
      surgeExempt = await this.chattedBefore(channel.id, userId, override.since);
      if (surgeExempt) required = own;
    }

    let verified: VerifiedWatchValue | null;
    try {
      verified = await this.verified.get(`${channel.id}:${userId}`, () =>
        this.d.valkey.get(KEYS.verifiedWatch(channel.id, userId)).then((raw) => parseJson(raw, VerifiedWatchValue)),
      );
    } catch (err) {
      return this.unavailable(required, err);
    }
    return {
      requiredSeconds: required,
      // A key for another broadcast is stale: a new broadcast starts from zero (decision 1).
      verified:
        verified && verified.b === broadcastId
          ? { broadcastId: verified.b, seconds: verified.s, fallback: verified.f === 1 }
          : null,
      surgeExempt,
      fallbackAccountAgeDays: await this.fallbackAccountAgeDays(),
      unavailable: false,
    };
  }

  /** After a `msg_verified_watch` rejection: counts the attempt; returns `msg_ratelimit` past WATCH_GATE_ATTEMPTS, else the rejection unchanged. */
  async denied(channelId: string, userId: string, r: Rejection, now: Date): Promise<Rejection> {
    try {
      const ok = await this.d.limiter.hit(
        `${WATCH_GATE_ATTEMPTS.bucket}:${channelId}`,
        userId,
        WATCH_GATE_ATTEMPTS.perMinute,
        ATTEMPT_WINDOW_MS,
        now.getTime(),
      );
      return ok ? r : RATE_LIMITED;
    } catch (err) {
      this.warn("verified-watch attempt limit unavailable", err);
      return r;
    }
  }

  /** A `surge` control frame arrived for the channel: drop the cached override so the next send reads it. */
  invalidate(channelId: string): void {
    this.overrides.delete(channelId);
  }

  /** Surge state for the `joined` frame (§1.4); `off` on any error (fail open). */
  async surge(channel: ChannelState, _now: Date): Promise<SurgeFrameState> {
    if (!this.d.enabled.surgeGuard || !channel.settings.surgeGuard.enabled) return { state: "off", until: null };
    try {
      const o = await this.readOverride(channel.id);
      return o ? { state: o.state, until: o.until } : { state: "off", until: null };
    } catch (err) {
      this.warn("surge state unavailable", err);
      return { state: "off", until: null };
    }
  }

  private readOverride(channelId: string): Promise<SurgeOverride | null> {
    return this.overrides.get(channelId, () =>
      this.d.valkey.get(KEYS.surgeOverride(channelId)).then((raw) => parseJson(raw, SurgeOverride)),
    );
  }

  /** One indexed query (`chat_messages_user_idx`): a non-deleted message in the channel before `since`. */
  private async chattedBefore(channelId: string, userId: string, since: string): Promise<boolean> {
    const at = new Date(since);
    if (Number.isNaN(at.getTime())) return false;
    const m = schema.chatMessages;
    try {
      return await this.exempt.get(`${channelId}:${userId}:${since}`, async () => {
        const rows = await this.d.db
          .select({ one: sql<number>`1` })
          .from(m)
          .where(and(eq(m.userId, userId), eq(m.channelId, channelId), isNull(m.deletedAt), lt(m.createdAt, at)))
          .limit(1);
        return rows.length > 0;
      });
    } catch (err) {
      // Exempt on a database error: an earlier chatter must not be silenced by an outage.
      this.warn("surge exemption lookup failed", err);
      return true;
    }
  }

  private async fallbackAccountAgeDays(): Promise<number> {
    try {
      return await this.thresholds.get("t", async () => {
        const [row] = await this.d.db
          .select({ value: schema.governanceSettings.value })
          .from(schema.governanceSettings)
          .where(eq(schema.governanceSettings.key, "integrity.thresholds"));
        const parsed = Thresholds.safeParse(row?.value ?? {});
        return parsed.success ? parsed.data.gateFallbackAccountAgeDays : DEFAULT_FALLBACK_ACCOUNT_AGE_DAYS;
      });
    } catch {
      return DEFAULT_FALLBACK_ACCOUNT_AGE_DAYS;
    }
  }

  private unavailable(required: number, err: unknown): WatchGateState {
    this.failOpen(err);
    return {
      requiredSeconds: required,
      verified: null,
      surgeExempt: false,
      fallbackAccountAgeDays: DEFAULT_FALLBACK_ACCOUNT_AGE_DAYS,
      unavailable: true,
    };
  }

  private failOpen(err: unknown): null {
    this.d.metrics.watchGateUnavailable();
    this.warn("verified-watch gate unavailable; failing open", err);
    return null;
  }

  /** At most one warning a minute: an outage would otherwise log once per message. */
  private warn(msg: string, err: unknown): void {
    const now = this.clock();
    if (now - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = now;
    this.d.logger.warn(msg, errorFields(err));
  }
}
