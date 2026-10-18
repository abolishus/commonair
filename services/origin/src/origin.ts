// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Wires the origin together; main.ts adds env loading and the HTTP runtime. */
import { MEDIA_INTERNAL_USER, STREAMS } from "@commonair/contracts/internal";
import type { Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { importSigningKey } from "@commonair/tokens";
import { MINUTE_MS, SegmentLog } from "./accounting.ts";
import { cdnAuthValue, RelayAuth } from "./auth.ts";
import { ChannelDirectory } from "./channels.ts";
import { parseCidr, type Cidr } from "./clientip.ts";
import { ContentStore, type ObjectRef, type MediaObject, type TtlPolicy } from "./content.ts";
import { createHandler, type OriginFetch } from "./handler.ts";
import { IssuanceRunner, runIssuance, type IssuanceRow } from "./issuance.ts";
import { noopMetrics, type OriginMetrics } from "./metrics.ts";
import { ProductionStore } from "./production.ts";
import { TokenRefresher } from "./refresh.ts";
import { MediaUpstream } from "./upstream.ts";

export interface OriginOptions {
  db: Executor;
  valkey: ValkeyClient;
  /** PLAYBACK_SIGNING_KEY: verifies viewer tokens and re-signs them near expiry. */
  playbackSigningKey: string;
  mediamtxHlsUrl: string;
  /** INTERNAL_API_SECRET: keys the CDN origin-pull HMAC. */
  internalSecret: string;
  /** MEDIA_INTERNAL_PASSWORD: basic-auth password of MediaMTX's `internal` user. */
  mediaPassword: string;
  cacheMb: number;
  cdn: { provider: "none" | "origin-pull"; baseUrl?: string };
  /** TRUSTED_PROXY_CIDRS. */
  trustedProxyCidrs?: string[];
  /** Stream name for SegmentFetch entries (tests use a unique one). */
  segmentStream?: string;
  segmentFlushMs?: number;
  /** Take part in relay issuance (leader-elected across replicas). */
  issuance?: { enabled: boolean; graceMs?: number; lookbackMinutes?: number };
  ttls?: Partial<TtlPolicy>;
  upstreamConcurrency?: number;
  upstreamBlockingConcurrency?: number;
  upstreamQueueWaitMs?: number;
  maxBlockingKeysPerPath?: number;
  relayAuthFailuresPerMinute?: number;
  logger?: Logger;
  metrics?: OriginMetrics;
  now?: () => number;
}

export interface Origin {
  fetch: OriginFetch;
  upstream: MediaUpstream;
  store: ContentStore;
  segments: SegmentLog;
  production: ProductionStore;
  /** Compute and store relay issuance for one minute bucket, without the leader lock. */
  runIssuance(bucketStartMs: number): Promise<IssuanceRow[]>;
  /** One leader-locked issuance tick over the recent closed minutes; null when another replica leads. */
  issuanceTick(): Promise<IssuanceRow[] | null>;
  start(): void;
  stop(): Promise<void>;
}

export async function createOrigin(opts: OriginOptions): Promise<Origin> {
  const now = opts.now ?? Date.now;
  const metrics = opts.metrics ?? noopMetrics;
  const signingKey = await importSigningKey(opts.playbackSigningKey);
  const production = new ProductionStore({ valkey: opts.valkey, logger: opts.logger, metrics });

  const upstream = new MediaUpstream({
    baseUrl: opts.mediamtxHlsUrl,
    user: MEDIA_INTERNAL_USER,
    password: opts.mediaPassword,
    concurrency: opts.upstreamConcurrency,
    blockingConcurrency: opts.upstreamBlockingConcurrency,
    queueWaitMs: opts.upstreamQueueWaitMs,
  });
  const onFetched = (ref: ObjectRef, obj: MediaObject) => {
    if (ref.kind !== "playlist") production.record(ref.upstreamPath, ref.file, ref.kind, obj.body.byteLength, now());
  };
  const store = new ContentStore({
    upstream,
    cacheBytes: opts.cacheMb * 1024 * 1024,
    ttls: opts.ttls,
    maxBlockingKeysPerPath: opts.maxBlockingKeysPerPath,
    metrics,
    onFetched,
    now,
  });
  const segments = new SegmentLog({
    valkey: opts.valkey,
    stream: opts.segmentStream ?? STREAMS.segments,
    flushMs: opts.segmentFlushMs,
    logger: opts.logger,
    metrics,
  });
  const trustedProxies = (opts.trustedProxyCidrs ?? []).flatMap((c) => {
    const parsed = parseCidr(c);
    if (!parsed) opts.logger?.warn("ignoring invalid TRUSTED_PROXY_CIDRS entry");
    return parsed ? [parsed] : [];
  }) satisfies Cidr[];
  const fetchHandler = createHandler({
    publicKey: signingKey.publicKey,
    store,
    channels: new ChannelDirectory({ db: opts.db, valkey: opts.valkey, logger: opts.logger }),
    relays: new RelayAuth({ db: opts.db }),
    segments,
    refresher: new TokenRefresher({ key: signingKey, db: opts.db, now: () => Math.floor(now() / 1000) }),
    cdn: {
      enabled: opts.cdn.provider === "origin-pull",
      baseUrl: opts.cdn.baseUrl,
      authValue: await cdnAuthValue(opts.internalSecret),
    },
    trustedProxies,
    relayAuthFailuresPerMinute: opts.relayAuthFailuresPerMinute,
    metrics,
    logger: opts.logger,
    now,
  });

  const runner = new IssuanceRunner({
    db: opts.db,
    valkey: opts.valkey,
    production,
    lookbackMinutes: opts.issuance?.lookbackMinutes,
    logger: opts.logger,
    now,
  });
  let align: ReturnType<typeof setTimeout> | undefined;
  let every: ReturnType<typeof setInterval> | undefined;
  let issuing: Promise<IssuanceRow[] | null> | undefined;
  const issuanceTick = () => {
    issuing ??= runner
      .tick()
      .catch((err: unknown) => {
        opts.logger?.error("relay issuance failed", { err });
        return null;
      })
      .finally(() => (issuing = undefined));
    return issuing;
  };

  return {
    fetch: fetchHandler,
    upstream,
    store,
    segments,
    production,
    runIssuance: (bucketStartMs) => runIssuance(opts.db, production, bucketStartMs),
    issuanceTick,
    start() {
      segments.start();
      if (opts.issuance?.enabled) {
        // Fire `grace` after each minute boundary so heartbeats just after the minute are counted.
        const grace = opts.issuance.graceMs ?? 10_000;
        const wait = MINUTE_MS - (now() % MINUTE_MS) + grace;
        align = setTimeout(() => {
          void issuanceTick();
          every = setInterval(() => void issuanceTick(), MINUTE_MS);
        }, wait);
      }
    },
    async stop() {
      clearTimeout(align);
      clearInterval(every);
      await issuing;
      await Promise.allSettled([segments.stop(), production.flush()]);
      // A last tick, so the minutes this replica just finished are not left to a successor.
      if (opts.issuance?.enabled) await issuanceTick();
    },
  };
}
