// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `watchRooms.*` (ADR 0017, decision (q)). Contract-step stub: W3-watch-rooms fills it. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const watchRooms = {
  create: os.watchRooms.create.handler(() => notImplemented()),
  get: os.watchRooms.get.handler(() => notImplemented()),
  invite: os.watchRooms.invite.handler(() => notImplemented()),
  join: os.watchRooms.join.handler(() => notImplemented()),
  leave: os.watchRooms.leave.handler(() => notImplemented()),
  close: os.watchRooms.close.handler(() => notImplemented()),
  mine: os.watchRooms.mine.handler(() => notImplemented()),
};
