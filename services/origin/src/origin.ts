// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Wires the origin together; main.ts adds env loading and the HTTP runtime. */
import { MEDIA_INTERNAL_USER, STREAMS } from "@commonair/contracts/internal";
import type { Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { importSigningKey } from "@commonair/tokens";
import { EgressAccumulator, MINUTE_MS, ProductionTracker, SegmentLog } from "./accounting.ts";
import { cdnAuthValue, RelayAuth } from "./auth.ts";
import { ChannelDirectory } from "./channels.ts";
import { ContentStore, type ObjectRef, type MediaObject, type TtlPolicy } from "./content.ts";
import { createHandler } from "./handler.ts";
import { issuanceBucket, runIssuance, type IssuanceRow } from "./issuance.ts";
import { noopMetrics, type OriginMetrics } from "./metrics.ts";
import { mediaSegmentUris } from "./playlist.ts";
import { MediaUpstream } from "./upstream.ts";

export interface OriginOptions {
  db: Executor;
  valkey: ValkeyClient;
  /** PLAYBACK_SIGNING_KEY; only its public half is used here. */
  playbackSigningKey: string;
  mediamtxHlsUrl: string;
  internalSecret: string;
  cacheMb: number;
  cdn: { provider: "none" | "origin-pull"; baseUrl?: string };
  /** Stream name for SegmentFetch entries (tests use a unique one). */
  segmentStream?: string;
  segmentFlushMs?: number;
  egressFlushMs?: number;
  /** Run relay issuance on a 60 s timer in this process. */
  issuance?: { enabled: boolean; graceMs?: number };
  ttls?: Partial<TtlPolicy>;
  upstreamConcurrency?: number;
  logger?: Logger;
  metrics?: OriginMetrics;
  now?: () => number;
}

export interface Origin {
  fetch: (req: Request) => Promise<Response>;
  upstream: MediaUpstream;
  store: ContentStore;
  segments: SegmentLog;
  egress: EgressAccumulator;
  production: ProductionTracker;
  /** Compute and store relay issuance for one minute bucket (defaults to the last complete minute). */
  runIssuance(bucketStartMs?: number): Promise<IssuanceRow[]>;
  start(): void;
  stop(): Promise<void>;
}

export async function createOrigin(opts: OriginOptions): Promise<Origin> {
  const now = opts.now ?? Date.now;
  const metrics = opts.metrics ?? noopMetrics;
  const { publicKey } = await importSigningKey(opts.playbackSigningKey);
  const production = new ProductionTracker();
  const dec = new TextDecoder();

  const upstream = new MediaUpstream({
    baseUrl: opts.mediamtxHlsUrl,
    user: MEDIA_INTERNAL_USER,
    password: opts.internalSecret,
    concurrency: opts.upstreamConcurrency,
  });
  const onFetched = (ref: ObjectRef, obj: MediaObject) => {
    const channelPath = ref.upstreamPath.split("/").slice(0, 2).join("/");
    const at = now();
    if (ref.kind === "playlist") {
      if (ref.file !== "index.m3u8")
        production.notePlaylist(channelPath, ref.upstreamPath, mediaSegmentUris(dec.decode(obj.body)), at);
    } else production.noteObject(channelPath, ref.upstreamPath, ref.kind, obj.body.byteLength, at);
  };
  const store = new ContentStore({
    upstream,
    cacheBytes: opts.cacheMb * 1024 * 1024,
    ttls: opts.ttls,
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
  const egress = new EgressAccumulator({ db: opts.db, flushMs: opts.egressFlushMs, logger: opts.logger, metrics });
  const channels = new ChannelDirectory({ db: opts.db, valkey: opts.valkey, logger: opts.logger });
  const relays = new RelayAuth({ db: opts.db });
  const fetchHandler = createHandler({
    publicKey,
    store,
    channels,
    relays,
    segments,
    egress,
    cdn: {
      enabled: opts.cdn.provider === "origin-pull",
      baseUrl: opts.cdn.baseUrl,
      authValue: await cdnAuthValue(opts.internalSecret),
    },
    metrics,
    logger: opts.logger,
    now,
  });

  const issuance = (bucketStartMs = issuanceBucket(now())) =>
    runIssuance(opts.db, (path, bucket) => production.get(path, bucket), bucketStartMs);

  let align: ReturnType<typeof setTimeout> | undefined;
  let every: ReturnType<typeof setInterval> | undefined;
  let issuing: Promise<unknown> | undefined;
  const issuanceTick = () => {
    if (issuing) return;
    issuing = issuance()
      .catch((err: unknown) => opts.logger?.error("relay issuance failed", { err }))
      .finally(() => {
        issuing = undefined;
        production.prune(now());
      });
  };

  return {
    fetch: fetchHandler,
    upstream,
    store,
    segments,
    egress,
    production,
    runIssuance: issuance,
    start() {
      segments.start();
      egress.start();
      if (opts.issuance?.enabled) {
        // Fire `grace` after each minute boundary so heartbeats just after the minute are counted.
        const grace = opts.issuance.graceMs ?? 10_000;
        const wait = MINUTE_MS - (now() % MINUTE_MS) + grace;
        align = setTimeout(() => {
          issuanceTick();
          every = setInterval(issuanceTick, MINUTE_MS);
        }, wait);
      }
    },
    async stop() {
      clearTimeout(align);
      clearInterval(every);
      await issuing;
      await Promise.allSettled([segments.stop(), egress.stop()]);
    },
  };
}
