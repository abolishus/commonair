// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `stream.setupState` and `stream.setupMark` (overhaul wave 3, D5.1): the "Ready to go live" checklist. */
import { os, requireChannel } from "../lib/orpc.ts";
import { twitchImportAvailable } from "../raw-routes.ts";
import { markSetupStep, readSetupState } from "../studio/setup.ts";

export const streamSetup = {
  setupState: os.stream.setupState.handler(async ({ context }) => {
    const c = requireChannel(context);
    return readSetupState(context.deps.db, c.id, twitchImportAvailable(context.deps.env));
  }),
  setupMark: os.stream.setupMark.handler(async ({ context, input }) => {
    const c = requireChannel(context);
    await markSetupStep(context.deps.db, c.id, input.step);
    return { ok: true as const };
  }),
};
