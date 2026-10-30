// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel's median viewer latency (`KEYS.chatLatency`, ADR 0012 amendment 1 decision 4),
 * written by the integrity worker after each scoring pass and read here for sends without a
 * `mediaTs` hint. A read never blocks or fails a send: missing, malformed, slow or failed → null.
 */
import { KEYS } from "@commonair/contracts/internal";
import { createLogger, type Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { TtlCache } from "./cache.ts";
import { errorFields } from "./errors.ts";

export interface ChannelLatencyOptions {
  /** In-process cache per channel; the key itself lives 60 s and is rewritten every 15 s. */
  ttlMs?: number;
  /** A Valkey read slower than this counts as no key. */
  timeoutMs?: number;
  logger?: Logger;
}

/** Same bound the worker caps the median to; a larger value would only be clamped away. */
const MAX_SECONDS = 60;
const TIMED_OUT = Symbol("timed out");

export function parseLatency(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_SECONDS);
}

export class ChannelLatency {
  private readonly cache: TtlCache<string, number | null>;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(
    private readonly valkey: ValkeyClient,
    opts: ChannelLatencyOptions = {},
  ) {
    this.cache = new TtlCache(opts.ttlMs ?? 5_000);
    this.timeoutMs = opts.timeoutMs ?? 250;
    this.logger = opts.logger ?? createLogger({ service: "chat" });
  }

  /** Seconds, or null when the channel has no (usable) key. */
  async get(channelId: string): Promise<number | null> {
    return this.cache.get(channelId, () => this.read(channelId));
  }

  private async read(channelId: string): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), this.timeoutMs);
      });
      const raw = await Promise.race([this.valkey.get(KEYS.chatLatency(channelId)), timeout]);
      if (raw === TIMED_OUT) {
        this.logger.debug("chat latency read timed out", { channelId });
        return null;
      }
      return parseLatency(raw);
    } catch (err) {
      // Cached as null for the TTL, so a Valkey outage costs one failed read per channel per TTL.
      this.logger.debug("chat latency read failed", { ...errorFields(err), channelId });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
