// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `POST /metrics/ui` (overhaul wave 2, D2.8; growth-funnels.md P7 B): one count per call, closed
 * lists only. The handler never reads the session, and nothing about the sender is stored: the
 * per-address token bucket lives in Valkey under a key hashed with a salt that changes every UTC
 * day, and expires within minutes. A per (surface, day) cap stops a flood from inflating a row.
 * Every outcome answers Ok, so a capped sender learns nothing.
 */
import type { UiMetricEvent } from "@commonair/contracts/dto";
import { schema } from "@commonair/db";
import { hmacHex } from "@commonair/tokens";
import { sql } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { rateLimitSubjectIp } from "../lib/netrange.ts";

export interface UiMetricLimits {
  /** Counts one address may send at once. */
  burst: number;
  /** Tokens returned per second. */
  refillPerSecond: number;
  /** Counts kept per surface and UTC day, across every sender. */
  surfaceDayCap: number;
}

/** A page fires a handful of views and clicks; 30 at once and one every 2 s after that is plenty. */
export const UI_METRIC_LIMITS: UiMetricLimits = { burst: 30, refillPerSecond: 0.5, surfaceDayCap: 100_000 };

/** The bucket key lives this long after the last hit (it is full again well before). */
const BUCKET_TTL_MS = 5 * 60_000;
/** The surface cap's key outlives its UTC day by a day. */
const CAP_TTL_SECONDS = 2 * 86_400;

const BUCKET_PREFIX = "ui-metrics:tb:";
const CAP_PREFIX = "ui-metrics:cap:";

// KEYS[1] = bucket; ARGV = burst, refill per ms, now ms, ttl ms. Returns 1 when a token was taken.
const TOKEN_BUCKET = `
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local v = redis.call('HMGET', KEYS[1], 't', 'ts')
local tokens = tonumber(v[1])
local ts = tonumber(v[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate)
local ok = 0
if tokens >= 1 then
  tokens = tokens - 1
  ok = 1
end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return ok
`;

// KEYS[1] = cap counter; ARGV = cap, ttl s. Counts the hit and returns 1 while under the cap.
const SURFACE_CAP = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
if n <= tonumber(ARGV[1]) then return 1 end
return 0
`;

/** The UTC calendar day of `at`, `YYYY-MM-DD`. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * The bucket key for an address on a day. The day is part of the HMAC input, so yesterday's keys
 * cannot be linked to today's, and the address itself is never written anywhere.
 */
export async function bucketKey(secret: string, ip: string, day: string): Promise<string> {
  return `${BUCKET_PREFIX}${await hmacHex(secret, `ui-metrics:${day}:${rateLimitSubjectIp(ip)}`)}`;
}

export type UiMetricOutcome = "counted" | "rate_limited" | "capped";

/** Count one UI event, unless the sender's bucket is empty or the surface hit today's cap. */
export async function recordUiMetric(
  deps: Pick<Deps, "db" | "valkey" | "now" | "env">,
  ip: string,
  event: UiMetricEvent,
  limits: UiMetricLimits = UI_METRIC_LIMITS,
): Promise<UiMetricOutcome> {
  const at = deps.now();
  const day = utcDay(at);
  const key = await bucketKey(deps.env.AUTH_SECRET, ip, day);
  const took = await deps.valkey.eval(
    TOKEN_BUCKET,
    1,
    key,
    limits.burst,
    limits.refillPerSecond / 1000,
    at.getTime(),
    BUCKET_TTL_MS,
  );
  if (Number(took) !== 1) return "rate_limited";
  const under = await deps.valkey.eval(
    SURFACE_CAP,
    1,
    `${CAP_PREFIX}${day}:${event.surface}`,
    limits.surfaceDayCap,
    CAP_TTL_SECONDS,
  );
  if (Number(under) !== 1) return "capped";
  const t = schema.uiCounters;
  await deps.db
    .insert(t)
    .values({ day, surface: event.surface, action: event.action, step: event.step, count: 1 })
    .onConflictDoUpdate({
      target: [t.day, t.surface, t.action, t.step],
      set: { count: sql`${t.count} + 1`, updatedAt: sql`now()` },
    });
  return "counted";
}
