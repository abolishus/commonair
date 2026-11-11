// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cross-channel shelves (overhaul wave 2, D3.1): `vods.listRecent` ("Catch up") and
 * `clips.listRecent` ("Fresh clips"). Public; the rules live in `discovery/recent.ts`.
 */
import { listRecentClips, listRecentVods } from "../discovery/recent.ts";
import { os } from "../lib/orpc.ts";

export const vodsRecent = {
  listRecent: os.vods.listRecent.handler(({ context, input }) => listRecentVods(context.deps, context.caller, input)),
};
export const clipsRecent = {
  listRecent: os.clips.listRecent.handler(({ context, input }) => listRecentClips(context.deps, context.caller, input)),
};
