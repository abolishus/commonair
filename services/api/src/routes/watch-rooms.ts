// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `watchRooms.*` (ADR 0017, decision (q)): thin handlers over `watch-rooms/service.ts`. */
import { os, requireCaller } from "../lib/orpc.ts";
import { closeRoom, createRoom, getRoom, joinRoom, leaveRoom, myRooms, newInvite } from "../watch-rooms/service.ts";

export const watchRooms = {
  create: os.watchRooms.create.handler(({ context, input }) =>
    createRoom(context.deps, requireCaller(context), input.channel),
  ),
  get: os.watchRooms.get.handler(({ context, input }) => getRoom(context.deps, requireCaller(context), input.id)),
  invite: os.watchRooms.invite.handler(({ context, input }) =>
    newInvite(context.deps, requireCaller(context), input.id),
  ),
  join: os.watchRooms.join.handler(({ context, input }) =>
    joinRoom(context.deps, requireCaller(context), input.id, input.nonce),
  ),
  leave: os.watchRooms.leave.handler(async ({ context, input }) => {
    await leaveRoom(context.deps, requireCaller(context), input.id);
    return { ok: true as const };
  }),
  close: os.watchRooms.close.handler(async ({ context, input }) => {
    await closeRoom(context.deps, requireCaller(context), input.id);
    return { ok: true as const };
  }),
  mine: os.watchRooms.mine.handler(({ context }) => myRooms(context.deps, requireCaller(context))),
};
