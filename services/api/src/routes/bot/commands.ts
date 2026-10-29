// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.commands.*` (E8-bot-api). */
import { and, eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { listCommands, removeCommand, upsertCommand, visibleCommands } from "../../bot/commands.ts";
import { channelAuthority } from "../../lib/access.ts";
import { channelBySlug } from "../../lib/dto.ts";
import { notFound } from "../../lib/errors.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const commands = {
  // Public: the middleware resolves no channel role, so the handler decides what the caller sees.
  list: os.bot.commands.list.handler(async ({ context: { deps, caller }, input }) => {
    const channel = await channelBySlug(deps, input.channel);
    if (!channel) throw notFound("Channel not found");
    const roles = caller
      ? (
          await deps.db
            .select({ role: schema.channelRoles.role })
            .from(schema.channelRoles)
            .where(and(eq(schema.channelRoles.channelId, channel.id), eq(schema.channelRoles.userId, caller.user.id)))
        ).map((r) => r.role)
      : [];
    return visibleCommands(await listCommands(deps, channel.id), channelAuthority(caller, channel, roles));
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
