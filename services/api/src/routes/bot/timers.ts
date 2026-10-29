// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.timers.*` (E8-bot-api). */
import { listTimers, removeTimer, upsertTimer } from "../../bot/timers.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const timers = {
  list: os.bot.timers.list.handler(async ({ context }) => listTimers(context.deps, requireChannel(context).id)),

  upsert: os.bot.timers.upsert.handler(async ({ context, input }) => {
    const { channel: _slug, ...timer } = input;
    return upsertTimer(context.deps, requireChannel(context), requireCaller(context).user.id, timer);
  }),

  remove: os.bot.timers.remove.handler(async ({ context, input }) => {
    await removeTimer(context.deps, requireChannel(context), requireCaller(context).user.id, input.id);
    return { ok: true as const };
  }),
};
