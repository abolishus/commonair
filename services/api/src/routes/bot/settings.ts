// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.settings` and `bot.updateSettings` (E8-bot-api). */
import { getBotSettings, updateBotSettings } from "../../bot/settings.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const settings = os.bot.settings.handler(async ({ context }) =>
  getBotSettings(context.deps, requireChannel(context)),
);

export const updateSettings = os.bot.updateSettings.handler(async ({ context, input }) =>
  updateBotSettings(context.deps, requireChannel(context), requireCaller(context).user.id, {
    enabled: input.enabled,
    config: input.config,
  }),
);
