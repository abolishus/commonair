// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.timers.*`. Owned by E8-bot-api; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const timers = {
  list: os.bot.timers.list.handler(notImplemented),
  upsert: os.bot.timers.upsert.handler(notImplemented),
  remove: os.bot.timers.remove.handler(notImplemented),
};
