// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What MediaMTX produced, per channel directory per minute: the input to relay
 * issuance. Kept in Valkey, not in process, so it survives origin restarts and is
 * aggregated across every origin replica.
 *
 * Each distinct media object (full segment, LL-HLS part, init section) pulled from
 * MediaMTX is counted once in the minute it was first pulled by any replica: an
 * atomic script claims a short-lived "seen" key for the object and, only if the claim
 * succeeds, adds to the minute's hash. Replicas pull each object within seconds of
 * its creation, so a 120 s claim is enough to deduplicate them; the per-replica cache
 * prevents re-pulls in between.
 */
import { KEYS } from "@commonair/contracts/internal";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { MINUTE_MS } from "./accounting.ts";
import { noopMetrics, type OriginMetrics } from "./metrics.ts";
import type { MediaKind } from "./paths.ts";

export const ISSUANCE_KEYS = {
  production: KEYS.issuanceProduction,
  seen: KEYS.issuanceSeen,
  lock: KEYS.issuanceLock,
} as const;

/** Production hashes outlive the 5-minute recompute window comfortably. */
export const PRODUCTION_TTL_SECONDS = 20 * 60;
export const SEEN_TTL_SECONDS = 120;

/** What MediaMTX produced in one directory (source or a rendition) of a channel in one minute. */
export interface DirProduction {
  /** Full media segments first pulled during the minute (all tracks of the directory). */
  segments: number;
  segmentBytes: number;
  /** LL-HLS parts first pulled during the minute. */
  parts: number;
  partBytes: number;
  /** Init sections (EXT-X-MAP) first pulled during the minute. */
  inits: number;
  initBytes: number;
}
/** dir (e.g. `live/alice/720p`) → production. */
export type ChannelMinute = Map<string, DirProduction>;

export type ObjectClass = "segment" | "part" | "init";
const FIELDS: Record<ObjectClass, [count: keyof DirProduction, bytes: keyof DirProduction]> = {
  segment: ["segments", "segmentBytes"],
  part: ["parts", "partBytes"],
  init: ["inits", "initBytes"],
};
const METRICS = new Set<string>(Object.values(FIELDS).flat());

export const objectClass = (file: string, kind: Exclude<MediaKind, "playlist">): ObjectClass =>
  /_init\.[a-z0-9]+$/.test(file) ? "init" : kind;

export const channelPathOf = (dir: string) => dir.split("/").slice(0, 2).join("/");
export const emptyDir = (): DirProduction => ({
  segments: 0,
  segmentBytes: 0,
  parts: 0,
  partBytes: 0,
  inits: 0,
  initBytes: 0,
});

/** Parse a production hash into channel path → directory → production. */
export function parseProduction(hash: Record<string, string>): Map<string, ChannelMinute> {
  const out = new Map<string, ChannelMinute>();
  for (const [field, value] of Object.entries(hash)) {
    const bar = field.lastIndexOf("|");
    const dir = field.slice(0, bar);
    const metric = field.slice(bar + 1);
    const n = Number(value);
    if (bar <= 0 || !METRICS.has(metric) || !Number.isSafeInteger(n)) continue;
    const channel = channelPathOf(dir);
    let minute = out.get(channel);
    if (!minute) out.set(channel, (minute = new Map()));
    let d = minute.get(dir);
    if (!d) minute.set(dir, (d = emptyDir()));
    d[metric as keyof DirProduction] = n;
  }
  return out;
}

const RECORD_SCRIPT = `
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then
  redis.call('HINCRBY', KEYS[2], ARGV[3], 1)
  redis.call('HINCRBY', KEYS[2], ARGV[4], ARGV[5])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  return 1
end
return 0`;

export interface ProductionStoreOptions {
  valkey: Pick<ValkeyClient, "eval" | "hgetall">;
  logger?: Logger;
  metrics?: OriginMetrics;
  /** Bound on unacknowledged writes while Valkey is slow. */
  maxPending?: number;
}

export class ProductionStore {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly metrics: OriginMetrics;

  constructor(private readonly opts: ProductionStoreOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
  }

  /** Count one media object pulled from MediaMTX. Never awaited by a response. */
  record(dir: string, file: string, kind: Exclude<MediaKind, "playlist">, bytes: number, at: number): void {
    if (this.pending.size >= (this.opts.maxPending ?? 10_000)) {
      this.metrics.accountingDropped("production", 1);
      return;
    }
    const [countField, bytesField] = FIELDS[objectClass(file, kind)];
    const p = this.opts.valkey
      .eval(
        RECORD_SCRIPT,
        2,
        ISSUANCE_KEYS.seen(`${dir}/${file}`),
        ISSUANCE_KEYS.production(Math.floor(at / MINUTE_MS)),
        SEEN_TTL_SECONDS,
        PRODUCTION_TTL_SECONDS,
        `${dir}|${countField}`,
        `${dir}|${bytesField}`,
        bytes,
      )
      .catch((err: unknown) => {
        this.metrics.accountingDropped("production", 1);
        this.opts.logger?.warn("production record failed", { err });
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Wait for every write issued so far (shutdown, tests). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  /** Aggregated production of all replicas for the minute starting at `bucketStartMs`. */
  async read(bucketStartMs: number): Promise<Map<string, ChannelMinute>> {
    return parseProduction(await this.opts.valkey.hgetall(ISSUANCE_KEYS.production(bucketStartMs / MINUTE_MS)));
  }
}
