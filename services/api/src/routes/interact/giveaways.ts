// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.giveaways.*` (ADR 0039, decisions (s), (t); logic in `../../interact/giveaways/service.ts`).
 * Every procedure answers FORBIDDEN (`giveaways_disabled`) while `GIVEAWAYS_ENABLED` is false.
 */
import {
  cancelGiveaway,
  closeGiveaway,
  currentGiveaway,
  drawGiveaway,
  enterGiveawayAs,
  openGiveaway,
  verifyGiveaway,
} from "../../interact/giveaways/service.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const giveaways = {
  current: os.interact.giveaways.current.handler(({ context, input }) =>
    currentGiveaway(context.deps, input.channel, context.caller),
  ),
  open: os.interact.giveaways.open.handler(({ context, input }) =>
    openGiveaway(context.deps, requireCaller(context), requireChannel(context), input),
  ),
  enter: os.interact.giveaways.enter.handler(({ context, input }) =>
    enterGiveawayAs(context.deps, requireCaller(context), input.id),
  ),
  close: os.interact.giveaways.close.handler(({ context, input }) =>
    closeGiveaway(context.deps, requireCaller(context), requireChannel(context), input.id),
  ),
  draw: os.interact.giveaways.draw.handler(({ context, input }) =>
    drawGiveaway(context.deps, requireCaller(context), requireChannel(context), input.id),
  ),
  cancel: os.interact.giveaways.cancel.handler(({ context, input }) =>
    cancelGiveaway(context.deps, requireCaller(context), requireChannel(context), input.id),
  ),
  verify: os.interact.giveaways.verify.handler(({ context, input }) =>
    verifyGiveaway(context.deps, input.channel, input.id),
  ),
};
