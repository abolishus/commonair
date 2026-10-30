// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Channel median viewer latency (`KEYS.chatLatency`, ADR 0012 amendment 1 decision 4), written after each scoring pass. Stub until W1-spine implements it. */
import type { WorkerContext } from "../context.ts";

export async function writeChatLatency(_ctx: WorkerContext): Promise<{ channels: number }> {
  return { channels: 0 };
}
