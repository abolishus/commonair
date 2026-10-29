// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Goal progress in the outbox relay transaction (ADR 0026 decision 5, Amendment 1): advance each
 * channel's open goal of the matching type for the follows, subscriptions and tips in `events`,
 * and write `channel.goal.progress`/`end` in the same transaction. Returns how many goals moved.
 * Owned by E8-raids-goals; a no-op until it lands.
 */
import type { BusEvent } from "@commonair/contracts/events";
import type { Executor } from "@commonair/db";
import type { WorkerContext } from "../../context.ts";

export async function applyGoalProgress(
  _tx: Executor,
  _events: readonly BusEvent[],
  _ctx: WorkerContext,
): Promise<number> {
  return 0;
}
