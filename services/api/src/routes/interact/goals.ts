// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.goals.*` (ADR 0026 decision 5; rules in `../../interact/goals/service.ts`). Owned by E8-raids-goals. */
import { createGoal, endGoal, listGoals } from "../../interact/goals/service.ts";
import { channelBySlug } from "../../lib/dto.ts";
import { notFound } from "../../lib/errors.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const goals = {
  list: os.interact.goals.list.handler(async ({ context, input }) => {
    // Public: the middleware resolves channels for owner and moderator procedures only.
    const channel = await channelBySlug(context.deps, input.channel);
    if (!channel) throw notFound("Channel not found");
    return listGoals(context.deps.db, channel.id);
  }),
  create: os.interact.goals.create.handler(async ({ context, input }) =>
    createGoal(context.deps, requireChannel(context), requireCaller(context).user.id, {
      type: input.type,
      title: input.title,
      target: input.target,
    }),
  ),
  end: os.interact.goals.end.handler(async ({ context, input }) =>
    endGoal(context.deps, requireChannel(context), requireCaller(context).user.id, input.id),
  ),
};
