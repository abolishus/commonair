// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `channels.schedule.*` (overhaul wave 5). Contract step stubs: w5-schedule implements them. */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

const notYet = (): never => {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
};

export const channelSchedule = {
  schedule: { get: os.channels.schedule.get.handler(notYet), set: os.channels.schedule.set.handler(notYet) },
};
