// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NoticeCode } from "@commonair/contracts";

/**
 * Upstream notice code → Twitch IRC `msg-id`. Most codes already are Twitch
 * msg-ids. Where Twitch has a different id for the same situation we map to it
 * (held by moderation ≙ AutoMod hold `msg_rejected`, blocked ≙
 * `msg_rejected_mandatory`) so tmi.js fires the matching event (`automod`).
 * Codes Twitch has no equivalent for keep their name: clients treat unknown
 * msg-ids as plain notices.
 */
export const NOTICE_MSG_IDS: Readonly<Record<NoticeCode, string>> = {
  msg_banned: "msg_banned",
  usage: "unrecognized_cmd",
  invalid_user: "invalid_user",
  msg_timedout: "msg_timedout",
  msg_slowmode: "msg_slowmode",
  msg_followersonly: "msg_followersonly",
  msg_subsonly: "msg_subsonly",
  msg_emoteonly: "msg_emoteonly",
  msg_ratelimit: "msg_ratelimit",
  msg_duplicate: "msg_duplicate",
  msg_rejected: "msg_rejected_mandatory",
  msg_held: "msg_rejected",
  msg_account_too_new: "msg_account_too_new",
  msg_verified_email: "msg_verified_email",
  msg_channel_suspended: "msg_channel_suspended",
  msg_requires_login: "msg_requires_login",
  msg_links_blocked: "msg_links_blocked",
  msg_verified_watch: "msg_verified_watch",
  no_permission: "no_permission",
  unrecognized_cmd: "unrecognized_cmd",
  cmd_success: "cmd_success",
  slow_on: "slow_on",
  slow_off: "slow_off",
  followers_on: "followers_on",
  followers_off: "followers_off",
  subs_on: "subs_on",
  subs_off: "subs_off",
  emote_only_on: "emote_only_on",
  emote_only_off: "emote_only_off",
};

/**
 * Twitch reports a successful moderation command with a command-specific msg-id
 * (tmi.js resolves `client.ban()` on `ban_success`, …). Upstream sends a
 * generic `cmd_success`; the session remembers which command it sent and maps here.
 * Commands absent from this table (clear, chat modes) have their own notices or
 * state lines, so their `cmd_success` is not forwarded.
 */
export const COMMAND_SUCCESS_MSG_IDS: Readonly<Record<string, string>> = {
  ban: "ban_success",
  unban: "unban_success",
  timeout: "timeout_success",
  untimeout: "untimeout_success",
  delete: "delete_message_success",
  mod: "mod_success",
  unmod: "unmod_success",
  vip: "vip_success",
  unvip: "unvip_success",
};

/** msg-id for an upstream notice; codes this gateway does not know (a newer upstream) → `unrecognized_cmd`. */
export function noticeMsgId(code: string, command?: string): string | null {
  if (code === "cmd_success" && command !== undefined) return COMMAND_SUCCESS_MSG_IDS[command] ?? null;
  return (NOTICE_MSG_IDS as Record<string, string | undefined>)[code] ?? "unrecognized_cmd";
}
