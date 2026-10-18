// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stateful send limits shared by every chat instance through Valkey: slow mode, the per-user
 * per-channel sliding-window rate limit, and duplicate suppression. Slow mode and duplicates
 * are only *recorded* once a message is accepted (`commit`), so a rejected message never
 * starts a slow-mode wait; the rate limit counts every attempt, like Twitch.
 */
import type { ValkeyClient } from "@commonair/service";
import { KEYS } from "@commonair/contracts";

export interface Limiter {
  /** Milliseconds until the user may speak again under slow mode (0 = now). */
  slowRemainingMs(channelId: string, userId: string): Promise<number>;
  /** Count one attempt; false when the window is full. */
  hit(channelId: string, userId: string, limit: number, windowMs: number, now: number): Promise<boolean>;
  isDuplicate(channelId: string, userId: string, body: string): Promise<boolean>;
  /** Record an accepted message for slow mode and duplicate detection. */
  commit(
    channelId: string,
    userId: string,
    body: string,
    slowModeSeconds: number,
    duplicateWindowMs: number,
  ): Promise<void>;
}

/** Bodies are compared exactly; a 96-bit SHA-256 prefix keeps keys short without storing message text. */
const bodyDigest = async (body: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  return Array.from(bytes.subarray(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
};

const SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
if redis.call('ZCARD', key) >= limit then return 0 end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return 1
`;

export class ValkeyLimiter implements Limiter {
  constructor(private readonly valkey: ValkeyClient) {}

  async slowRemainingMs(channelId: string, userId: string): Promise<number> {
    const ttl = await this.valkey.pttl(`chat:slow:${channelId}:${userId}`);
    return ttl > 0 ? ttl : 0;
  }

  async hit(channelId: string, userId: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    const member = `${now}:${crypto.randomUUID()}`;
    const ok = await this.valkey.eval(
      SLIDING_WINDOW,
      1,
      KEYS.rateLimit("chat", `${channelId}:${userId}`),
      now,
      windowMs,
      limit,
      member,
    );
    return ok === 1;
  }

  async isDuplicate(channelId: string, userId: string, body: string): Promise<boolean> {
    return (await this.valkey.exists(`chat:dup:${channelId}:${userId}:${await bodyDigest(body)}`)) === 1;
  }

  async commit(channelId: string, userId: string, body: string, slowModeSeconds: number, duplicateWindowMs: number) {
    const ops: Promise<unknown>[] = [
      this.valkey.set(`chat:dup:${channelId}:${userId}:${await bodyDigest(body)}`, "1", "PX", duplicateWindowMs),
    ];
    if (slowModeSeconds > 0)
      ops.push(this.valkey.set(`chat:slow:${channelId}:${userId}`, "1", "PX", slowModeSeconds * 1000));
    await Promise.all(ops);
  }
}

/** In-process limiter with the same semantics, for unit tests and single-node development. */
export class MemoryLimiter implements Limiter {
  private readonly slow = new Map<string, number>();
  private readonly windows = new Map<string, number[]>();
  private readonly dups = new Map<string, number>();
  constructor(private readonly clock: () => number = Date.now) {}

  async slowRemainingMs(channelId: string, userId: string): Promise<number> {
    const until = this.slow.get(`${channelId}:${userId}`) ?? 0;
    return Math.max(0, until - this.clock());
  }

  async hit(channelId: string, userId: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    const key = `${channelId}:${userId}`;
    const hits = (this.windows.get(key) ?? []).filter((t) => t > now - windowMs);
    if (hits.length >= limit) {
      this.windows.set(key, hits);
      return false;
    }
    hits.push(now);
    this.windows.set(key, hits);
    return true;
  }

  async isDuplicate(channelId: string, userId: string, body: string): Promise<boolean> {
    const until = this.dups.get(`${channelId}:${userId}\0${body}`) ?? 0;
    return until > this.clock();
  }

  async commit(channelId: string, userId: string, body: string, slowModeSeconds: number, duplicateWindowMs: number) {
    const now = this.clock();
    this.dups.set(`${channelId}:${userId}\0${body}`, now + duplicateWindowMs);
    if (slowModeSeconds > 0) this.slow.set(`${channelId}:${userId}`, now + slowModeSeconds * 1000);
  }
}
