// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Verified-watch keys (`KEYS.verifiedWatch`, ADR 0015 decision 1), written after each scoring pass. Stub until W1-watch-gate implements it. */
import type { WorkerContext } from "../context.ts";

export async function writeVerifiedWatch(_ctx: WorkerContext): Promise<{ channels: number; keys: number }> {
  return { channels: 0, keys: 0 };
}
