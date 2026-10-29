// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Timers: a message the bot posts every `intervalMinutes`, only after `minChatLines` new lines. */
import { and, asc, count, eq, sql } from "drizzle-orm";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { notFound, precondition } from "../lib/errors.ts";
import { publishBotControl } from "./control.ts";
import { toBotTimer, type BotTimer } from "./dto.ts";

const { botTimers } = schema;

export const MAX_TIMERS_PER_CHANNEL = 20;

type Channel = { id: string };
export type TimerInput = Omit<BotTimer, "id"> & { id?: string | undefined };

export async function listTimers(deps: Deps, channelId: string): Promise<BotTimer[]> {
  const rows = await deps.db
    .select()
    .from(botTimers)
    .where(eq(botTimers.channelId, channelId))
    .orderBy(asc(botTimers.id));
  return rows.map(toBotTimer);
}

export async function upsertTimer(deps: Deps, channel: Channel, actorId: string, input: TimerInput): Promise<BotTimer> {
  const values = {
    name: input.name,
    message: input.message,
    intervalMinutes: input.intervalMinutes,
    minChatLines: input.minChatLines,
    enabled: input.enabled,
  };
  const row = await deps.db.transaction(async (tx) => {
    let saved: typeof botTimers.$inferSelect | undefined;
    if (input.id) {
      [saved] = await tx
        .update(botTimers)
        .set(values)
        .where(and(eq(botTimers.id, input.id), eq(botTimers.channelId, channel.id)))
        .returning();
      if (!saved) throw notFound("Timer not found");
    } else {
      // Serialize creates per channel so two cannot both pass the limit check.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`bot_timers:${channel.id}`}, 0))`);
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(botTimers)
        .where(eq(botTimers.channelId, channel.id));
      if (n >= MAX_TIMERS_PER_CHANNEL)
        throw precondition("bot_timer_limit", `A channel can have at most ${MAX_TIMERS_PER_CHANNEL} timers`);
      [saved] = await tx
        .insert(botTimers)
        .values({ channelId: channel.id, ...values })
        .returning();
      if (!saved) throw new Error("timer insert returned no row");
    }
    await audit(tx, {
      actorType: "user",
      actorId,
      action: input.id ? "bot.timer.update" : "bot.timer.create",
      subjectType: "bot_timer",
      subjectId: saved.id,
      channelId: channel.id,
    });
    return saved;
  });
  await publishBotControl(deps, channel.id, "timers");
  return toBotTimer(row);
}

export async function removeTimer(deps: Deps, channel: Channel, actorId: string, id: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(botTimers)
      .where(and(eq(botTimers.id, id), eq(botTimers.channelId, channel.id)))
      .returning({ id: botTimers.id });
    if (!gone) throw notFound("Timer not found");
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "bot.timer.remove",
      subjectType: "bot_timer",
      subjectId: gone.id,
      channelId: channel.id,
    });
  });
  await publishBotControl(deps, channel.id, "timers");
}
