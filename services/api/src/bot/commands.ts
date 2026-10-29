// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Custom commands. Names and aliases share one namespace per channel and never shadow the bot
 * engine's built-ins. Command text is streamer content: it never goes into audit details.
 */
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { BOT_BUILTIN_COMMANDS } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { badRequest, conflict, notFound, precondition } from "../lib/errors.ts";
import { publishBotControl } from "./control.ts";
import { toBotCommand, type BotCommand } from "./dto.ts";

const { botCommands } = schema;

export const MAX_COMMANDS_PER_CHANNEL = 200;

type Channel = { id: string };
export type CommandInput = Omit<BotCommand, "id" | "useCount">;

/** Viewers see enabled commands; the owner, editors and moderators see all of them. */
export function visibleCommands<T extends { enabled: boolean }>(
  commands: readonly T[],
  authority: "owner" | "editor" | "moderator" | null,
): T[] {
  return authority ? [...commands] : commands.filter((c) => c.enabled);
}

/** Aliases deduplicated, without the command's own name. */
export function normalizeAliases(name: string, aliases: readonly string[]): string[] {
  return [...new Set(aliases)].filter((a) => a !== name);
}

/** The first of `names` the bot engine answers itself, if any. */
export function builtinClash(names: readonly string[]): string | null {
  const builtins: readonly string[] = BOT_BUILTIN_COMMANDS;
  return names.find((n) => builtins.includes(n)) ?? null;
}

export async function listCommands(deps: Deps, channelId: string): Promise<BotCommand[]> {
  const rows = await deps.db
    .select()
    .from(botCommands)
    .where(eq(botCommands.channelId, channelId))
    .orderBy(asc(botCommands.name));
  return rows.map(toBotCommand);
}

export async function upsertCommand(
  deps: Deps,
  channel: Channel,
  actorId: string,
  input: CommandInput,
): Promise<BotCommand> {
  const aliases = normalizeAliases(input.name, input.aliases);
  const names = [input.name, ...aliases];
  const builtin = builtinClash(names);
  if (builtin) throw badRequest(`"${builtin}" is a built-in command`);

  const row = await deps.db.transaction(async (tx) => {
    // One writer per channel: the collision and limit checks below read the whole command set.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`bot_commands:${channel.id}`}, 0))`);
    const namesArray = sql`array[${sql.join(
      names.map((n) => sql`${n}`),
      sql`, `,
    )}]::text[]`;
    const [clash] = await tx
      .select({ id: botCommands.id })
      .from(botCommands)
      .where(
        and(
          eq(botCommands.channelId, channel.id),
          ne(botCommands.name, input.name),
          sql`(${botCommands.name} = any(${namesArray}) or ${botCommands.aliases} && ${namesArray})`,
        ),
      )
      .limit(1);
    if (clash) throw conflict("Another command already uses that name or alias");

    const [existing] = await tx
      .select({ id: botCommands.id })
      .from(botCommands)
      .where(and(eq(botCommands.channelId, channel.id), eq(botCommands.name, input.name)));
    if (!existing) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(botCommands)
        .where(eq(botCommands.channelId, channel.id));
      if (n >= MAX_COMMANDS_PER_CHANNEL)
        throw precondition("bot_command_limit", `A channel can have at most ${MAX_COMMANDS_PER_CHANNEL} commands`);
    }

    const values = {
      aliases,
      response: input.response,
      userLevel: input.userLevel,
      cooldownSeconds: input.cooldownSeconds,
      costPoints: input.costPoints,
      enabled: input.enabled,
    };
    // `useCount` is the engine's to keep: an edit never resets it.
    const [saved] = await tx
      .insert(botCommands)
      .values({ channelId: channel.id, name: input.name, ...values })
      .onConflictDoUpdate({ target: [botCommands.channelId, botCommands.name], set: values })
      .returning();
    if (!saved) throw new Error("command upsert returned no row");
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "bot.command.upsert",
      subjectType: "bot_command",
      subjectId: saved.id,
      channelId: channel.id,
      details: { created: !existing },
    });
    return saved;
  });
  await publishBotControl(deps, channel.id, "commands");
  return toBotCommand(row);
}

export async function removeCommand(deps: Deps, channel: Channel, actorId: string, name: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(botCommands)
      .where(and(eq(botCommands.channelId, channel.id), eq(botCommands.name, name)))
      .returning({ id: botCommands.id });
    if (!gone) throw notFound("Command not found");
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "bot.command.remove",
      subjectType: "bot_command",
      subjectId: gone.id,
      channelId: channel.id,
    });
  });
  await publishBotControl(deps, channel.id, "commands");
}
