// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `stream.lastBroadcast` (overhaul wave 5). Contract step stub: w5-studio implements it. */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

const notYet = (): never => {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
};

export const streamLastBroadcast = { lastBroadcast: os.stream.lastBroadcast.handler(notYet) };
