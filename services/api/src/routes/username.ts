// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `users.usernameAvailable` (overhaul wave 2, D2.4 claim field). Contract step stub: d2-gate implements it. */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

export const usernameRoutes = {
  usernameAvailable: os.users.usernameAvailable.handler(() => {
    throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
  }),
};
