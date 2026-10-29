// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.predictions.*` (E8-polls; logic in `../../interact/predictions/service.ts`). */
import { requireAuthority } from "../../interact/polls/shared.ts";
import {
  betPrediction,
  createPrediction,
  currentPrediction,
  lockPredictionNow,
  settlePrediction,
} from "../../interact/predictions/service.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const predictions = {
  current: os.interact.predictions.current.handler(({ context, input }) =>
    currentPrediction(context.deps, input.channel, context.caller),
  ),
  create: os.interact.predictions.create.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const channel = requireChannel(context);
    // The middleware admitted the caller; this names their role for the audit row.
    const authority = await requireAuthority(context.deps.db, caller, channel);
    return createPrediction(context.deps, caller, authority, channel, input);
  }),
  bet: os.interact.predictions.bet.handler(({ context, input }) =>
    betPrediction(context.deps, requireCaller(context), input),
  ),
  lock: os.interact.predictions.lock.handler(({ context, input }) =>
    lockPredictionNow(context.deps, requireCaller(context), input.id),
  ),
  resolve: os.interact.predictions.resolve.handler(({ context, input }) =>
    settlePrediction(context.deps, requireCaller(context), input.id, input.winningOutcomeId),
  ),
  cancel: os.interact.predictions.cancel.handler(({ context, input }) =>
    settlePrediction(context.deps, requireCaller(context), input.id, null),
  ),
};
