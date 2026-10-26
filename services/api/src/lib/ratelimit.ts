// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sliding-window-log rate limiting. Each hit is a ZSET member scored by time;
 * the window slides continuously, so there is no burst at fixed-window edges.
 * Valkey runs the whole check-and-record as one Lua script (atomic across API replicas).
 */
import { KEYS } from "@commonair/contracts/internal";
import type { ValkeyClient } from "@commonair/service";

export type RateLimitBucket = "default" | "write" | "auth" | "chat" | "expensive" | "mail" | "playback";
export interface RateLimitRule {
  max: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMITS: Record<RateLimitBucket, RateLimitRule> = {
  default: { max: 120, windowMs: 60_000 },
  write: { max: 30, windowMs: 60_000 },
  auth: { max: 10, windowMs: 60_000 },
  chat: { max: 20, windowMs: 30_000 },
  expensive: { max: 5, windowMs: 3_600_000 },
  /** Per recipient address, across every sender (see recipientLimitedMailer). */
  mail: { max: 10, windowMs: 3_600_000 },
  /**
   * Per address for playback start, heartbeat and end. One viewer costs about 7 calls a minute
   * (a start, a beat every 10 s), so this admits a few hundred viewers behind one address.
   * Heartbeats also have a per-session floor (MIN_HEARTBEAT_WALL_SECONDS).
   */
  playback: { max: 3000, windowMs: 60_000 },
};

export interface RateLimitResult {
  allowed: boolean;
  /** Hits in the window including this one (when allowed). */
  count: number;
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  hit(key: string, rule: RateLimitRule, nowMs: number, member: string): Promise<RateLimitResult>;
}

/** Pure decision used by both stores: given the timestamps already in the window, may another hit pass? */
export function decide(timestampsInWindow: readonly number[], rule: RateLimitRule, nowMs: number): RateLimitResult {
  const live = timestampsInWindow.filter((t) => t > nowMs - rule.windowMs);
  if (live.length < rule.max) return { allowed: true, count: live.length + 1, retryAfterSeconds: 0 };
  const oldest = Math.min(...live);
  return {
    allowed: false,
    count: live.length,
    retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowMs - nowMs) / 1000)),
  };
}

export function memoryRateLimitStore(): RateLimitStore & { clear(): void } {
  const hits = new Map<string, number[]>();
  return {
    async hit(key, rule, nowMs) {
      const list = (hits.get(key) ?? []).filter((t) => t > nowMs - rule.windowMs);
      const r = decide(list, rule, nowMs);
      if (r.allowed) list.push(nowMs);
      hits.set(key, list);
      return r;
    },
    clear: () => hits.clear(),
  };
}

// KEYS[1] = bucket key; ARGV = now, window, max, member. Returns {allowed, count, oldest}.
const SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < max then
  redis.call('ZADD', key, now, ARGV[4])
  redis.call('PEXPIRE', key, window)
  return {1, count + 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, count, tonumber(oldest[2])}
`;

export function valkeyRateLimitStore(valkey: ValkeyClient): RateLimitStore {
  return {
    async hit(key, rule, nowMs, member) {
      const res = (await valkey.eval(SCRIPT, 1, key, nowMs, rule.windowMs, rule.max, member)) as [
        number,
        number,
        number,
      ];
      const [allowed, count, oldest] = res;
      if (allowed === 1) return { allowed: true, count, retryAfterSeconds: 0 };
      return {
        allowed: false,
        count,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowMs - nowMs) / 1000)),
      };
    },
  };
}

export const rateLimitKey = (bucket: RateLimitBucket, subject: string) => KEYS.rateLimit(bucket, subject);
