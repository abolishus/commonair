// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.variables.*` (E8-bot-api). */
import { listVariables, setVariable } from "../../bot/variables.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const variables = {
  list: os.bot.variables.list.handler(async ({ context }) => listVariables(context.deps, requireChannel(context).id)),

  set: os.bot.variables.set.handler(async ({ context, input }) => {
    await setVariable(context.deps, requireChannel(context), requireCaller(context).user.id, {
      name: input.name,
      value: input.value,
    });
    return { ok: true as const };
  }),
};
