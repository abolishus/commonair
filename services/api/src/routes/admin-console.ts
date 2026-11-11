// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `admin.overview`, `admin.user`, `admin.revealEmail` and `moderation.assign` (overhaul wave 4,
 * D7.5). The access layer already checked the role (`staff`, `safety-staff`, `admin`); the logic
 * is in `../admin-console/`.
 */
import { assignCase } from "../admin-console/assign.ts";
import { adminOverview } from "../admin-console/overview.ts";
import { adminUserView, revealEmail } from "../admin-console/user-view.ts";
import { os, requireCaller } from "../lib/orpc.ts";

export const adminConsole = {
  overview: os.admin.overview.handler(({ context }) =>
    adminOverview(context.deps.db, requireCaller(context).user.role, context.deps.now()),
  ),
  user: os.admin.user.handler(({ context, input }) =>
    adminUserView(context.deps, requireCaller(context), input.username),
  ),
  revealEmail: os.admin.revealEmail.handler(({ context, input }) =>
    revealEmail(context.deps, requireCaller(context), input),
  ),
};
export const caseAssign = {
  assign: os.moderation.assign.handler(({ context, input }) => assignCase(context.deps, requireCaller(context), input)),
};
