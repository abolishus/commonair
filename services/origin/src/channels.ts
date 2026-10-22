// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel liveness and rendition lookups with short caches. Offline and unknown
 * channels are cached for 2 s so a player hammering a dead stream never reaches
 * Postgres or MediaMTX more than every couple of seconds.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { RENDITIONS } from "@commonair/contracts/enums";
import { KEYS, SOURCE_AAC_STATES } from "@commonair/contracts/internal";
import type { Executor } from "@commonair/db";
import { schema } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { Coalescer, TtlCache } from "./cache.ts";
import type { Rendition } from "./paths.ts";

export interface LiveChannel {
  id: string;
  slug: string;
  broadcastId: string;
}

export interface ChannelDirectoryOptions {
  db: Executor;
  valkey: Pick<ValkeyClient, "get">;
  liveTtlMs?: number;
  offlineTtlMs?: number;
  renditionsTtlMs?: number;
  logger?: Logger;
}

const RenditionList = z.array(z.enum(RENDITIONS));
/** Whether the source is served as is, held back while media's AAC copy starts, or from the copy. */
export type SourceAacState = "off" | "pending" | "live";
/** Order in which renditions appear in the synthesized ladder (highest first). */
const LADDER: Rendition[] = ["1080p", "720p", "480p", "audio"];

export class ChannelDirectory {
  private readonly live = new TtlCache<LiveChannel | null>();
  private readonly lookups = new Coalescer<LiveChannel | null>();
  private readonly renditionCache = new TtlCache<Rendition[]>();
  private readonly renditionLookups = new Coalescer<Rendition[]>();
  private readonly sourceAacCache = new TtlCache<SourceAacState>();
  private readonly sourceAacLookups = new Coalescer<SourceAacState>();

  constructor(private readonly opts: ChannelDirectoryOptions) {}

  /** The live channel for `slug`, or null when unknown, offline or suspended. */
  async lookup(slug: string): Promise<LiveChannel | null> {
    const cached = this.live.get(slug);
    if (cached !== undefined) return cached;
    return this.lookups.run(slug, async () => {
      const c = schema.channels;
      const [row] = await this.opts.db
        .select({ id: c.id, liveBroadcastId: c.liveBroadcastId, suspendedAt: c.suspendedAt })
        .from(c)
        .where(eq(c.slug, slug))
        .limit(1);
      const value =
        row?.liveBroadcastId && !row.suspendedAt ? { id: row.id, slug, broadcastId: row.liveBroadcastId } : null;
      this.live.set(slug, value, value ? (this.opts.liveTtlMs ?? 5_000) : (this.opts.offlineTtlMs ?? 2_000));
      return value;
    }).promise;
  }

  /** Active non-source renditions in ladder order; empty = source only. */
  async renditions(channelId: string): Promise<Rendition[]> {
    const cached = this.renditionCache.get(channelId);
    if (cached) return cached;
    return this.renditionLookups.run(channelId, async () => {
      let value: Rendition[] = [];
      try {
        const raw = await this.opts.valkey.get(KEYS.renditions(channelId));
        if (raw) {
          const parsed = RenditionList.safeParse(JSON.parse(raw));
          if (parsed.success) value = LADDER.filter((r) => parsed.data.includes(r));
          else this.opts.logger?.warn("ignoring malformed renditions key", { channelId });
        }
      } catch (err) {
        // Degrade to source-only rather than failing playback.
        this.opts.logger?.warn("renditions lookup failed", { err, channelId });
      }
      this.renditionCache.set(channelId, value, this.opts.renditionsTtlMs ?? 2_000);
      return value;
    }).promise;
  }

  /**
   * Whether media publishes an AAC copy of the channel's source (`KEYS.sourceAac`, set for WHIP's
   * Opus audio). Same short cache as renditions; a failed lookup serves the original source.
   */
  async sourceAac(channelId: string): Promise<SourceAacState> {
    const cached = this.sourceAacCache.get(channelId);
    if (cached !== undefined) return cached;
    return this.sourceAacLookups.run(channelId, async () => {
      let value: SourceAacState = "off";
      try {
        const raw = await this.opts.valkey.get(KEYS.sourceAac(channelId));
        value = raw === SOURCE_AAC_STATES.live ? "live" : raw === SOURCE_AAC_STATES.pending ? "pending" : "off";
      } catch (err) {
        this.opts.logger?.warn("source-aac lookup failed", { err, channelId });
      }
      this.sourceAacCache.set(channelId, value, this.opts.renditionsTtlMs ?? 2_000);
      return value;
    }).promise;
  }
}
