// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.songRequests.*` (E8-bot-api; links only, no playback). */
import { listSongRequests, setSongRequestStatus } from "../../bot/song-requests.ts";
import { os, requireCaller, requireChannel } from "../../lib/orpc.ts";

export const list = os.bot.songRequests.list.handler(async ({ context, input }) =>
  listSongRequests(context.deps, requireChannel(context).id, input.status),
);

export const setStatus = os.bot.songRequests.setStatus.handler(async ({ context, input }) =>
  setSongRequestStatus(context.deps, requireChannel(context), requireCaller(context).user.id, {
    id: input.id,
    status: input.status,
  }),
);
