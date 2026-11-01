// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `transparency.*` (public): the open enforcement report (W2-enforcement-report). */
import { os } from "../lib/orpc.ts";
import { enforcementReport } from "../transparency/enforcement.ts";

export const transparency = {
  enforcement: os.transparency.enforcement.handler(({ context, input }) =>
    enforcementReport(context.deps, input.window),
  ),
};
