// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Command variables (`${var:name}` in templates). Values are streamer content: never audited. */
import { and, asc, count, eq, sql } from "drizzle-orm";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { precondition } from "../lib/errors.ts";
import { publishBotControl } from "./control.ts";

const { botVariables } = schema;

export const MAX_VARIABLES_PER_CHANNEL = 100;

export async function listVariables(deps: Deps, channelId: string): Promise<{ name: string; value: string }[]> {
  return deps.db
    .select({ name: botVariables.name, value: botVariables.value })
    .from(botVariables)
    .where(eq(botVariables.channelId, channelId))
    .orderBy(asc(botVariables.name));
}

export async function setVariable(
  deps: Deps,
  channel: { id: string },
  actorId: string,
  input: { name: string; value: string },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`bot_variables:${channel.id}`}, 0))`);
    const [existing] = await tx
      .select({ name: botVariables.name })
      .from(botVariables)
      .where(and(eq(botVariables.channelId, channel.id), eq(botVariables.name, input.name)));
    if (!existing) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(botVariables)
        .where(eq(botVariables.channelId, channel.id));
      if (n >= MAX_VARIABLES_PER_CHANNEL)
        throw precondition("bot_variable_limit", `A channel can have at most ${MAX_VARIABLES_PER_CHANNEL} variables`);
    }
    await tx
      .insert(botVariables)
      .values({ channelId: channel.id, name: input.name, value: input.value })
      .onConflictDoUpdate({
        target: [botVariables.channelId, botVariables.name],
        set: { value: input.value, updatedAt: deps.now() },
      });
    // The name is streamer-chosen text, so the row records only that a variable changed.
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "bot.variable.set",
      subjectType: "channel",
      subjectId: channel.id,
      channelId: channel.id,
      details: { created: !existing },
    });
  });
  await publishBotControl(deps, channel.id, "variables");
}
