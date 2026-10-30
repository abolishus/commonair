// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The verified-watch gate and surge guard reader (ADR 0015). Stub until W1-watch-gate implements it. */
import type { Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import type { Limiter } from "./limiter.ts";
import type { Metrics } from "./metrics.ts";
import type { ChannelState, Rejection, WatchGateState } from "./types.ts";

export interface WatchGateDeps {
  valkey: ValkeyClient;
  db: Database;
  limiter: Limiter;
  metrics: Metrics;
  logger: Logger;
  enabled: { watchGate: boolean; surgeGuard: boolean };
}

export class WatchGate {
  constructor(_d: WatchGateDeps) {}

  /** The gate state for one sender; null when neither the gate nor surge mode applies to the channel. */
  async load(_channel: ChannelState, _userId: string, _now: Date): Promise<WatchGateState | null> {
    return null;
  }

  /** After a `msg_verified_watch` rejection: counts the attempt; returns `msg_ratelimit` past WATCH_GATE_ATTEMPTS, else the rejection unchanged. */
  async denied(_channelId: string, _userId: string, r: Rejection, _now: Date): Promise<Rejection> {
    return r;
  }

  /** A `surge` control frame arrived for the channel: drop the cached override so the next send reads it. */
  invalidate(_channelId: string): void {}

  /** Surge state for the `joined` frame (§1.4); `off` on any error (fail open). */
  async surge(
    _channel: ChannelState,
    _now: Date,
  ): Promise<{ state: "off" | "on" | "suppressed"; until: string | null }> {
    return { state: "off", until: null };
  }
}
