// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat modes (overhaul wave 3, D4.4; ux-journeys J5-b, J5-c, J5-d): the moderator's chat-mode
 * controls and per-message actions as the `command` frames services/chat already parses
 * (`services/chat/src/commands.ts`), and the state chips every viewer sees, read from the
 * channel's `settings` frame. Pure, for unit tests: the server authorizes, writes the audit row
 * and the outbox event, and answers with a notice.
 */
import type { ChannelChatSettings } from "@commonair/contracts/shapes";
import { t } from "../i18n/index.ts";

/** One `{op:"command"}` frame's name and arguments. */
export interface ChatCommand {
  command: string;
  args: string[];
}

/** Slow-mode choices in the menu (J5-b: 5 s, 30 s, 2 min). */
export const SLOW_OPTIONS = [5, 30, 120] as const;
/** Followers-only choices: how long someone must have followed, in minutes (0 = any follower). */
export const FOLLOWER_AGE_OPTIONS = [0, 10, 60, 1440] as const;
/** Per-message timeout lengths (J5-d: 1 m, 10 m, 1 h, 24 h), in seconds. */
export const TIMEOUT_OPTIONS = [60, 600, 3600, 86_400] as const;
/** The timeout the menu's `chat-mod-timeout` item applies (the harness's 600 s). */
export const DEFAULT_TIMEOUT_SECONDS = 600;
/** The raid strip's quick actions (J5-c): followers of at least 10 minutes, and 30 s slow mode. */
export const RAID_FOLLOWER_MINUTES = 10;
export const RAID_SLOW_SECONDS = 30;

export const slowCommand = (seconds: number): ChatCommand =>
  seconds > 0 ? { command: "slow", args: [String(seconds)] } : { command: "slowoff", args: [] };

/** null turns followers-only off; a number of minutes is the follow age it asks for. */
export const followersCommand = (minutes: number | null): ChatCommand =>
  minutes === null ? { command: "followersoff", args: [] } : { command: "followers", args: [`${minutes}m`] };

export const subscribersCommand = (on: boolean): ChatCommand => ({
  command: on ? "subscribers" : "subscribersoff",
  args: [],
});

export const emoteOnlyCommand = (on: boolean): ChatCommand => ({
  command: on ? "emoteonly" : "emoteonlyoff",
  args: [],
});

export const CLEAR_COMMAND: ChatCommand = { command: "clear", args: [] };

/** The server's `/delete <message id>`. */
export const deleteCommand = (messageId: string): ChatCommand => ({ command: "delete", args: [messageId] });

export type ModeChip =
  | { kind: "slow"; seconds: number }
  | { kind: "followers"; minutes: number }
  | { kind: "subs" }
  | { kind: "emote" };

/** The modes that are on, in a fixed order; none before the join. */
export function activeModes(settings: ChannelChatSettings | null): ModeChip[] {
  if (!settings) return [];
  const chips: ModeChip[] = [];
  if (settings.slowModeSeconds > 0) chips.push({ kind: "slow", seconds: settings.slowModeSeconds });
  if (settings.followersOnlyMinutes !== null) chips.push({ kind: "followers", minutes: settings.followersOnlyMinutes });
  if (settings.subscribersOnly) chips.push({ kind: "subs" });
  if (settings.emoteOnly) chips.push({ kind: "emote" });
  return chips;
}

/** A duration in seconds as the menu says it ("5 seconds", "2 minutes", "1 hour", "24 hours"). */
export function durationLabel(seconds: number): string {
  if (seconds < 60) return t("d4Chat.duration.seconds", { count: seconds });
  if (seconds < 3600 || seconds % 3600 !== 0) return t("d4Chat.duration.minutes", { count: Math.round(seconds / 60) });
  return t("d4Chat.duration.hours", { count: seconds / 3600 });
}

/** A follow age in minutes; 0 is "any follower". */
export function followerAgeLabel(minutes: number): string {
  return minutes === 0 ? t("d4Chat.modes.followersAny") : durationLabel(minutes * 60);
}

/** The chip's short label ("Slow mode · 30 seconds"). */
export function modeChipLabel(chip: ModeChip): string {
  switch (chip.kind) {
    case "slow":
      return t("d4Chat.chip.slow", { duration: durationLabel(chip.seconds) });
    case "followers":
      return chip.minutes === 0
        ? t("d4Chat.chip.followers")
        : t("d4Chat.chip.followersAge", { duration: durationLabel(chip.minutes * 60) });
    case "subs":
      return t("d4Chat.chip.subs");
    case "emote":
      return t("d4Chat.chip.emote");
  }
}

/** The chip's one-sentence hint (its tooltip and accessible description). */
export function modeChipHint(chip: ModeChip, channel: string): string {
  switch (chip.kind) {
    case "slow":
      return t("d4Chat.hint.slow", { duration: durationLabel(chip.seconds) });
    case "followers":
      return chip.minutes === 0
        ? t("d4Chat.hint.followers", { channel })
        : t("d4Chat.hint.followersAge", { channel, duration: durationLabel(chip.minutes * 60) });
    case "subs":
      return t("d4Chat.hint.subs", { channel });
    case "emote":
      return t("d4Chat.hint.emote");
  }
}
