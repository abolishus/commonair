// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `giveaway-close` (ADR 0039 §2): close a giveaway's entries at its `closes_at`. The API schedules
 * it (delayed, one job id per giveaway) when a timed giveaway opens. Closing is the shared
 * `closeGiveawayInTx` (status `closed` and a `system` audit row in one transaction); the draw stays
 * the streamer's action. Early (a clock skew between the API and the worker) or for a giveaway that
 * is no longer open, it does nothing: the trigger already refuses entries past `closes_at`, and the
 * API closes a due giveaway on its next read.
 */
import { eq } from "drizzle-orm";
import { GIVEAWAY_JOBS, GiveawayCloseJob, QUEUES } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { closeGiveawayInTx } from "@commonair/interact";
import type { WorkerContext } from "../../context.ts";
import { defineJob } from "../../runtime/registry.ts";

/** Counts: `closed` 1 when this run closed it; `early` 1 when `closes_at` is still ahead (retried). */
export async function closeDueGiveaway(ctx: WorkerContext, giveawayId: string): Promise<Record<string, number>> {
  const now = ctx.now();
  const [g] = await ctx.db
    .select({ status: schema.giveaways.status, closesAt: schema.giveaways.closesAt })
    .from(schema.giveaways)
    .where(eq(schema.giveaways.id, giveawayId));
  if (!g || g.status !== "open") return { closed: 0, skipped: 1 };
  // A delayed job can fire a little before `closes_at` on a skewed clock: fail so BullMQ retries.
  if (g.closesAt === null) return { closed: 0, skipped: 1 };
  if (now < g.closesAt) throw new Error("giveaway-close ran before closes_at");
  const closed = await ctx.db.transaction((tx) =>
    closeGiveawayInTx(tx, giveawayId, now, { type: "system", id: null, trigger: "timed" }),
  );
  return { closed: closed ? 1 : 0, skipped: closed ? 0 : 1 };
}

export const job = defineJob({
  queue: QUEUES.interact,
  name: GIVEAWAY_JOBS.close,
  description: "Close a giveaway at its closes_at",
  data: GiveawayCloseJob,
  handler: (data, ctx) => closeDueGiveaway(ctx, data.giveawayId),
});
