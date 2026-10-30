// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Valkey state of the surge guard: the override (`KEYS.surgeOverride`) and the job's begin marker. */
import { KEYS, SurgeOverride } from "@commonair/contracts/internal";
import type { ValkeyClient } from "@commonair/service";

/**
 * Set while a recorded `chat.surge.begin` has no `chat.surge.end` yet, so a key that lapsed while
 * the worker was down still gets its end event (reason `expired`). The API's override writes the
 * same key (services/api/src/chat/surge.ts): keep the two in step.
 */
export const surgeOpenKey = (channelId: string): string => `surge-open:${channelId}`;
/** Long enough to outlive any cooldown (at most 120 minutes) plus a worker outage. */
export const SURGE_OPEN_TTL_SECONDS = 2 * 86_400;

/** Compare-and-set: replace (or delete, with an empty value) only if the key still holds `expected` ('' = absent). */
const CAS = `
local cur = redis.call('GET', KEYS[1])
if cur == false then
  if ARGV[1] ~= '' then return 0 end
elseif cur ~= ARGV[1] then
  return 0
end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end
return 1
`;

export interface StoredOverride {
  /** The raw string as read (the compare value for `casOverride`); null when absent. */
  raw: string | null;
  /** Parsed; null when absent or malformed. */
  value: SurgeOverride | null;
}

export async function readOverride(valkey: ValkeyClient, channelId: string): Promise<StoredOverride> {
  const raw = await valkey.get(KEYS.surgeOverride(channelId));
  if (raw === null) return { raw, value: null };
  try {
    const parsed = SurgeOverride.safeParse(JSON.parse(raw));
    return { raw, value: parsed.success ? parsed.data : null };
  } catch {
    return { raw, value: null };
  }
}

/** Write `next` (or delete with null) if nobody changed the key since `expected` was read. */
export async function casOverride(
  valkey: ValkeyClient,
  channelId: string,
  expected: string | null,
  next: SurgeOverride | null,
  ttlSeconds: number,
): Promise<boolean> {
  const r = await valkey.eval(
    CAS,
    1,
    KEYS.surgeOverride(channelId),
    expected ?? "",
    next ? JSON.stringify(next) : "",
    Math.max(1, Math.ceil(ttlSeconds)),
  );
  return r === 1;
}
