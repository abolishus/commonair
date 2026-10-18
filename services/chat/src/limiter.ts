// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stateful send limits shared by every chat instance through Valkey: slow mode, sliding-window
 * rate limits, and duplicate suppression. Slow mode and duplicates are *reserved* atomically at
 * check time (`SET NX PX`), so two concurrent sends cannot both pass; a message rejected by a
 * later rule releases its reservations, so a rejection never starts a slow-mode wait. The rate
 * limit counts every attempt, like Twitch.
 */
import type { ValkeyClient } from "@commonair/service";
import { KEYS } from "@commonair/contracts";

export interface Reservation {
  /** Undo the reservation (compare-and-delete: never removes someone else's). */
  release(): Promise<void>;
}

export type SlowResult = { ok: true; reservation: Reservation } | { ok: false; waitMs: number };

export interface Limiter {
  /** Claim the user's slow-mode slot for `seconds`, or report how long until it frees up. */
  reserveSlow(channelId: string, userId: string, seconds: number): Promise<SlowResult>;
  /** Count one attempt against `bucket`; false when the window is full. */
  hit(bucket: string, userId: string, limit: number, windowMs: number, now: number): Promise<boolean>;
  /** Claim `body` for the duplicate window; null when the same body was sent within it. */
  reserveDuplicate(channelId: string, userId: string, body: string, windowMs: number): Promise<Reservation | null>;
}

export const NO_RESERVATION: Reservation = { release: async () => {} };

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

const COMPARE_AND_DELETE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

export class ValkeyLimiter implements Limiter {
  constructor(private readonly valkey: ValkeyClient) {}

  private async claim(key: string, ttlMs: number): Promise<Reservation | null> {
    const token = crypto.randomUUID();
    const ok = await this.valkey.set(key, token, "PX", ttlMs, "NX");
    if (ok !== "OK") return null;
    return {
      release: async () => {
        await this.valkey.eval(COMPARE_AND_DELETE, 1, key, token);
      },
    };
  }

  async reserveSlow(channelId: string, userId: string, seconds: number): Promise<SlowResult> {
    const key = `chat:slow:${channelId}:${userId}`;
    const reservation = await this.claim(key, seconds * 1000);
    if (reservation) return { ok: true, reservation };
    const ttl = await this.valkey.pttl(key);
    // The key may have expired between SET and PTTL: report a minimal wait rather than racing.
    return { ok: false, waitMs: ttl > 0 ? ttl : 1 };
  }

  async hit(bucket: string, userId: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    const member = `${now}:${crypto.randomUUID()}`;
    const ok = await this.valkey.eval(
      SLIDING_WINDOW,
      1,
      KEYS.rateLimit("chat", `${bucket}:${userId}`),
      now,
      windowMs,
      limit,
      member,
    );
    return ok === 1;
  }

  async reserveDuplicate(
    channelId: string,
    userId: string,
    body: string,
    windowMs: number,
  ): Promise<Reservation | null> {
    return this.claim(`chat:dup:${channelId}:${userId}:${await bodyDigest(body)}`, windowMs);
  }
}

/** In-process limiter with the same semantics, for unit tests and single-node development. */
export class MemoryLimiter implements Limiter {
  private readonly claims = new Map<string, { until: number; token: symbol }>();
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly clock: () => number = Date.now) {}

  private claim(key: string, ttlMs: number): Reservation | null {
    const now = this.clock();
    const held = this.claims.get(key);
    if (held && held.until > now) return null;
    const token = Symbol(key);
    this.claims.set(key, { until: now + ttlMs, token });
    return {
      release: async () => {
        if (this.claims.get(key)?.token === token) this.claims.delete(key);
      },
    };
  }

  async reserveSlow(channelId: string, userId: string, seconds: number): Promise<SlowResult> {
    const key = `slow:${channelId}:${userId}`;
    const reservation = this.claim(key, seconds * 1000);
    if (reservation) return { ok: true, reservation };
    return { ok: false, waitMs: Math.max(1, (this.claims.get(key)?.until ?? 0) - this.clock()) };
  }

  async hit(bucket: string, userId: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    const key = `${bucket}:${userId}`;
    const hits = (this.windows.get(key) ?? []).filter((t) => t > now - windowMs);
    const ok = hits.length < limit;
    if (ok) hits.push(now);
    this.windows.set(key, hits);
    return ok;
  }

  async reserveDuplicate(
    channelId: string,
    userId: string,
    body: string,
    windowMs: number,
  ): Promise<Reservation | null> {
    return this.claim(`dup:${channelId}:${userId}\0${body}`, windowMs);
  }
}
