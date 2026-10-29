// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `bot.*`, composed from one file per area so each E8 unit owns its own (contract step §4.1):
 * settings, commands, timers, variables and song requests (E8-bot-api), points (E8-points).
 */
import { commands } from "./bot/commands.ts";
import { points } from "./bot/points.ts";
import { settings, updateSettings } from "./bot/settings.ts";
import { list, setStatus } from "./bot/song-requests.ts";
import { timers } from "./bot/timers.ts";
import { variables } from "./bot/variables.ts";

export const bot = {
  settings,
  updateSettings,
  commands,
  timers,
  variables,
  songRequests: { list, setStatus },
  points,
};
