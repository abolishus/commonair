// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.points.*` (E8-points): thin handlers over `../../points/service.ts`. */
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";
import { adjust, balanceOf, leaderboard } from "../../points/service.ts";

export const points = {
  balance: os.bot.points.balance.handler(({ context, input }) => balanceOf(context.deps.db, input)),

  leaderboard: os.bot.points.leaderboard.handler(({ context, input }) => leaderboard(context.deps.db, input)),

  adjust: os.bot.points.adjust.handler(({ context, input }) => {
    const caller = requireCaller(context);
    return adjust(context.deps.db, {
      channel: requireChannel(context),
      username: input.username,
      delta: input.delta,
      reason: input.reason,
      actorId: caller.user.id,
      now: context.deps.now(),
    });
  }),
};
