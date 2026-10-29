// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.commands.*` (E8-bot-api). */
import { listCommandsFor, removeCommand, upsertCommand } from "../../bot/commands.ts";
import { channelBySlug } from "../../lib/dto.ts";
import { notFound } from "../../lib/errors.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const commands = {
  // Public: the middleware resolves no channel role, so the handler decides what the caller sees.
  list: os.bot.commands.list.handler(async ({ context: { deps, caller }, input }) => {
    const channel = await channelBySlug(deps, input.channel);
    if (!channel) throw notFound("Channel not found");
    return listCommandsFor(deps, channel, caller);
  }),

  upsert: os.bot.commands.upsert.handler(async ({ context, input }) => {
    const { channel: _slug, ...command } = input;
    return upsertCommand(context.deps, requireChannel(context), requireCaller(context).user.id, command);
  }),

  remove: os.bot.commands.remove.handler(async ({ context, input }) => {
    await removeCommand(context.deps, requireChannel(context), requireCaller(context).user.id, input.name);
    return { ok: true as const };
  }),
};
