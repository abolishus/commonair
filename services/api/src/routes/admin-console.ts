// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `admin.overview`, `admin.user`, `admin.revealEmail` and `moderation.assign` (overhaul wave 4,
 * D7.5). Contract step stubs: d7-admin implements them.
 */
import { ORPCError } from "@orpc/server";
import { os } from "../lib/orpc.ts";

const notYet = (): never => {
  throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "Not available yet" });
};

export const adminConsole = {
  overview: os.admin.overview.handler(notYet),
  user: os.admin.user.handler(notYet),
  revealEmail: os.admin.revealEmail.handler(notYet),
};
export const caseAssign = { assign: os.moderation.assign.handler(notYet) };
