// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel bot settings. The first enable creates the channel's bot account (ADR 0026 decision 6:
 * the bot speaks as itself) and makes it a channel moderator, so chat gates admit it and its
 * filters can time out. Disabling keeps the account and the role. The role is granted once, at
 * creation: a later save never restores it, so an owner or moderator who revoked it on purpose
 * keeps that choice.
 */
import { eq } from "drizzle-orm";
import { BotConfig } from "@commonair/contracts/shapes";
import { schema } from "@commonair/db";
import { insertBotAccount, type UserRow } from "../auth/bot-account.ts";
import { changeRoleInTx } from "../channels/roles.ts";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { publishControl, publishUserControl } from "../lib/control.ts";
import { conflict, isUniqueViolation } from "../lib/errors.ts";
import { publishBotControl } from "./control.ts";
import { readBotConfig, type BotSettings } from "./dto.ts";
import { botUsernamePlan } from "./username.ts";

const { botConfigs, users } = schema;

type Tx = Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0];
type Channel = typeof schema.channels.$inferSelect;
type BotUser = Pick<UserRow, "id" | "username" | "name">;

async function botUserById(db: Deps["db"] | Tx, id: string): Promise<BotUser | null> {
  const [u] = await db
    .select({ id: users.id, username: users.username, name: users.name })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return u ?? null;
}

export async function getBotSettings(deps: Deps, channel: Channel): Promise<BotSettings> {
  const [row] = await deps.db.select().from(botConfigs).where(eq(botConfigs.channelId, channel.id)).limit(1);
  if (!row) return { enabled: false, config: BotConfig.parse({}), botUser: null };
  const bot = row.botUserId ? await botUserById(deps.db, row.botUserId) : null;
  return {
    enabled: row.enabled,
    config: readBotConfig(row.config),
    botUser: bot ? { id: bot.id, username: bot.username } : null,
  };
}

/** Matches `insertBotAccount`: a blank display name shows the username. */
const displayNameOf = (displayName: string, username: string) => displayName.trim() || username;

/** Insert under a savepoint so a taken username does not abort the caller's transaction. */
async function tryInsertBot(
  tx: Tx,
  p: { ownerId: string; username: string; displayName: string },
): Promise<UserRow | null> {
  try {
    return await tx.transaction((sp) => insertBotAccount(sp, p));
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

async function createChannelBot(tx: Tx, channel: Channel, displayName: string): Promise<BotUser> {
  const plan = botUsernamePlan(channel.slug);
  for (const username of [...plan.derived, plan.fallback]) {
    const bot = await tryInsertBot(tx, { ownerId: channel.ownerId, username, displayName });
    if (bot) return bot;
  }
  throw conflict("Could not find a free username for the channel bot");
}

export async function updateBotSettings(
  deps: Deps,
  channel: Channel,
  actorId: string,
  input: { enabled: boolean; config: BotConfig },
): Promise<BotSettings> {
  const result = await deps.db.transaction(async (tx) => {
    // Lock the row so two first enables cannot create two bot accounts.
    await tx
      .insert(botConfigs)
      .values({ channelId: channel.id, enabled: false, config: input.config })
      .onConflictDoNothing();
    const [row] = await tx.select().from(botConfigs).where(eq(botConfigs.channelId, channel.id)).for("update");
    if (!row) throw new Error("bot_configs row missing after upsert");

    let bot = row.botUserId ? await botUserById(tx, row.botUserId) : null;
    let botCreated = false;
    let nameChanged = false;
    if (!bot && input.enabled) {
      bot = await createChannelBot(tx, channel, input.config.displayName);
      botCreated = true;
    } else if (bot) {
      const name = displayNameOf(input.config.displayName, bot.username);
      if (name !== bot.name) {
        await tx.update(users).set({ name }).where(eq(users.id, bot.id));
        bot = { ...bot, name };
        nameChanged = true;
      }
    }
    const roleAdded =
      bot && botCreated
        ? await changeRoleInTx(tx, { channel, target: bot, role: "moderator", op: "add", actorId })
        : false;

    await tx
      .update(botConfigs)
      .set({ enabled: input.enabled, config: input.config, botUserId: bot?.id ?? null, updatedAt: deps.now() })
      .where(eq(botConfigs.channelId, channel.id));
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "bot.settings.update",
      subjectType: "channel",
      subjectId: channel.id,
      channelId: channel.id,
      details: { enabled: input.enabled, botCreated },
    });
    return { bot, roleAdded, nameChanged };
  });

  const { bot, roleAdded, nameChanged } = result;
  await publishBotControl(deps, channel.id, "config");
  if (bot && roleAdded) await publishControl(deps, channel.id, { op: "invalidate", scope: "user", userId: bot.id });
  if (bot && nameChanged)
    await publishUserControl(deps, { op: "invalidate", userId: bot.id, reason: "profile_changed" });
  return {
    enabled: input.enabled,
    config: input.config,
    botUser: bot ? { id: bot.id, username: bot.username } : null,
  };
}
