// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `stream.rehearsal.*` (W2-rehearsal); mounted by `./stream.ts`, the logic is `../stream/rehearsal.ts`. */
import { os, requireCaller, requireChannel, type Ctx } from "../lib/orpc.ts";
import {
  armRehearsal,
  disarmRehearsal,
  inviteToRehearsal,
  rehearsalReport,
  rehearsalStatus,
  watchRehearsal,
  type RehearsalActor,
} from "../stream/rehearsal.ts";

const actor = (context: Ctx): RehearsalActor => ({
  deps: context.deps,
  channel: requireChannel(context),
  userId: requireCaller(context).user.id,
});

export const rehearsal = {
  arm: os.stream.rehearsal.arm.handler(({ context }) => armRehearsal(actor(context))),
  disarm: os.stream.rehearsal.disarm.handler(({ context }) => disarmRehearsal(actor(context))),
  status: os.stream.rehearsal.status.handler(({ context }) => rehearsalStatus(actor(context))),
  invite: os.stream.rehearsal.invite.handler(({ context, input }) =>
    inviteToRehearsal(actor(context), { username: input.username, remove: input.remove }),
  ),
  report: os.stream.rehearsal.report.handler(({ context, input }) =>
    rehearsalReport(actor(context), input.broadcastId),
  ),
  watch: os.stream.rehearsal.watch.handler(({ context, input }) =>
    watchRehearsal(context.deps, requireCaller(context).user.id, { channel: input.channel, deviceId: input.deviceId }),
  ),
};
