// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.variables.*`. Owned by E8-bot-api; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const variables = {
  list: os.bot.variables.list.handler(notImplemented),
  set: os.bot.variables.set.handler(notImplemented),
};
