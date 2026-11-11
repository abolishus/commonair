// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `me.deletion.preview` (overhaul wave 4, D7.4): what deleting the account would change. */
import { deletionPreview } from "../deletion/preview.ts";
import { os, requireCaller } from "../lib/orpc.ts";

export const meDeletionPreview = {
  preview: os.me.deletion.preview.handler(async ({ context }) => {
    const caller = requireCaller(context);
    return deletionPreview(context.deps.db, caller.user.id, context.deps.env.CURRENCY);
  }),
};
