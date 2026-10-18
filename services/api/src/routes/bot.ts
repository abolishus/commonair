// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const bot = {
  settings: os.bot.settings.handler(notImplemented),
  updateSettings: os.bot.updateSettings.handler(notImplemented),
  commands: {
    list: os.bot.commands.list.handler(notImplemented),
    upsert: os.bot.commands.upsert.handler(notImplemented),
    remove: os.bot.commands.remove.handler(notImplemented),
  },
  timers: {
    list: os.bot.timers.list.handler(notImplemented),
    upsert: os.bot.timers.upsert.handler(notImplemented),
    remove: os.bot.timers.remove.handler(notImplemented),
  },
  variables: {
    list: os.bot.variables.list.handler(notImplemented),
    set: os.bot.variables.set.handler(notImplemented),
  },
  songRequests: os.bot.songRequests.handler(notImplemented),
  points: {
    balance: os.bot.points.balance.handler(notImplemented),
    leaderboard: os.bot.points.leaderboard.handler(notImplemented),
    adjust: os.bot.points.adjust.handler(notImplemented),
  },
};
