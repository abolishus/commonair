// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `me.moderates` (overhaul wave 3, J5-a): the channels the caller moderates or edits. */
import { os, requireCaller } from "../lib/orpc.ts";
import { listModerated } from "../studio/moderates.ts";

export const meModerates = {
  moderates: os.me.moderates.handler(async ({ context }) => {
    const caller = requireCaller(context);
    return listModerated(context.deps, caller.user.id);
  }),
};
