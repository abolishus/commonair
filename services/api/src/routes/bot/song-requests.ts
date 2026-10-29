// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `bot.songRequests.*` (links only; no playback). Owned by E8-bot-api; 501 until it lands. */
import { notImplemented } from "../../lib/errors.ts";
import { os } from "../../lib/orpc.ts";

export const list = os.bot.songRequests.list.handler(notImplemented);

export const setStatus = os.bot.songRequests.setStatus.handler(notImplemented);
