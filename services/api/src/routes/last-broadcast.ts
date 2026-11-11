// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `stream.lastBroadcast` (overhaul wave 5, D5.3): the recap's exact counts (`stream/last-broadcast.ts`). */
import { os, requireChannel } from "../lib/orpc.ts";
import { readLastBroadcast } from "../stream/last-broadcast.ts";

export const streamLastBroadcast = {
  lastBroadcast: os.stream.lastBroadcast.handler(async ({ context }) =>
    readLastBroadcast(context.deps.db, requireChannel(context).id),
  ),
};
