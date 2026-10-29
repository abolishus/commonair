// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.commands.*`. Owned by E8-bot-api; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const commands = {
  list: os.bot.commands.list.handler(notImplemented),
  upsert: os.bot.commands.upsert.handler(notImplemented),
  remove: os.bot.commands.remove.handler(notImplemented),
};
