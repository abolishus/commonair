// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Waves for moderators (J5-d). Moderators always see raw chat, so a wave is not a collapsed row
 * for them: under the latest copy of each wave the panel adds a row with "Time out all {n}
 * senders" and "Delete all". It uses Calm Chat's grouping (same text within its window, staff,
 * own and mentioning messages never grouped).
 */
import { MESSAGE_SET_RULES } from "@commonair/contracts/enums";
import type { ChatRow } from "../state.ts";
import { groupMessages, waveReport, type Wave } from "./reducer.ts";

/**
 * A moderator's wave row appears from this many copies. Calm Chat groups pairs, but in raw chat a
 * row after every two "lol"s would bury the log, so moderators see it from three.
 */
export const MOD_WAVE_MIN = 3;

/** The waves worth a moderator row, keyed by their latest message's id (where the row goes). */
export function modWaves(rows: readonly ChatRow[], self: string | null): Map<string, Wave> {
  const out = new Map<string, Wave>();
  for (const wave of new Set(groupMessages(rows, { self }).values()))
    if (wave.count >= MOD_WAVE_MIN) out.set(wave.latest.id, wave);
  return out;
}

/** The ids `chat.bans.bulk` and "Delete all" act on: newest first, capped at the contract's maximum. */
export const waveMessageIds = (wave: Wave): string[] => waveReport(wave, MESSAGE_SET_RULES.maxMessages).messageIds;
