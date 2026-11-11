// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `me.moderates` (overhaul wave 3, J5-a). Contract step stub: d5-shell implements it. */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

export const meModerates = {
  moderates: os.me.moderates.handler((): never => {
    throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
  }),
};
