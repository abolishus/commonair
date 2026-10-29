// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `interact.raids.*` (ADR 0026 decision 4; rules in `../../interact/raids/service.ts`). Owned by E8-raids-goals. */
import { cancelRaid, raidState, setRaidPolicy, startRaid } from "../../interact/raids/service.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const raids = {
  start: os.interact.raids.start.handler(async ({ context, input }) =>
    startRaid(context.deps, requireChannel(context), requireCaller(context).user.id, input.to),
  ),
  cancel: os.interact.raids.cancel.handler(async ({ context }) => {
    await cancelRaid(context.deps, requireChannel(context), requireCaller(context).user.id);
    return { ok: true as const };
  }),
  current: os.interact.raids.current.handler(async ({ context }) =>
    raidState(context.deps, requireChannel(context).id),
  ),
  setPolicy: os.interact.raids.setPolicy.handler(async ({ context, input }) =>
    setRaidPolicy(context.deps, requireChannel(context), requireCaller(context).user.id, input.policy),
  ),
};
