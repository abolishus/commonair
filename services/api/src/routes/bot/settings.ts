// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.settings` and `bot.updateSettings`. Owned by E8-bot-api; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const settings = os.bot.settings.handler(notImplemented);

export const updateSettings = os.bot.updateSettings.handler(notImplemented);
