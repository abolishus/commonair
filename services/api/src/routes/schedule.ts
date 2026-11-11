// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `channels.schedule.*` and `stream.lastBroadcast` (overhaul wave 5). Contract step stubs. */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

const notYet = (): never => {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
};

/** w5-schedule implements these. */
export const channelSchedule = {
  schedule: { get: os.channels.schedule.get.handler(notYet), set: os.channels.schedule.set.handler(notYet) },
};

/** w5-studio implements this. */
export const streamLastBroadcast = { lastBroadcast: os.stream.lastBroadcast.handler(notYet) };
