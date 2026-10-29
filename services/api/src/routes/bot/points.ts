// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.points.*`. Owned by E8-points; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const points = {
  balance: os.bot.points.balance.handler(notImplemented),
  leaderboard: os.bot.points.leaderboard.handler(notImplemented),
  adjust: os.bot.points.adjust.handler(notImplemented),
};
