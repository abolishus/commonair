// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The channel's median viewer latency (`KEYS.chatLatency`, ADR 0012 amendment 1 decision 4). Stub until W1-spine implements it. */
import type { ValkeyClient } from "@commonair/service";

export class ChannelLatency {
  constructor(_valkey: ValkeyClient, _opts?: { ttlMs?: number }) {}

  /** Seconds, or null when the channel has no key. */
  async get(_channelId: string): Promise<number | null> {
    return null;
  }
}
