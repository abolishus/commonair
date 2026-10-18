// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat server notices and errors in the viewer's language. The server's `text`/`message` is
 * English for IRC clients; the browser shows the catalog string for its code instead.
 */
import type { NoticeCode } from "@commonair/contracts/chat";
import { t, type MessageKey } from "../i18n/index.ts";

const NOTICES: Record<NoticeCode, MessageKey> = {
  msg_banned: "chat.notice.banned",
  msg_timedout: "chat.notice.timedOut",
  msg_slowmode: "chat.notice.slowMode",
  msg_followersonly: "chat.notice.followersOnly",
  msg_subsonly: "chat.notice.subsOnly",
  msg_emoteonly: "chat.notice.emoteOnly",
  msg_ratelimit: "chat.notice.rateLimit",
  msg_duplicate: "chat.notice.duplicate",
  msg_rejected: "chat.notice.rejected",
  msg_held: "chat.notice.held",
  msg_account_too_new: "chat.notice.accountTooNew",
  msg_verified_email: "chat.notice.verifiedEmail",
  msg_channel_suspended: "chat.notice.channelSuspended",
  msg_requires_login: "chat.notice.requiresLogin",
  msg_links_blocked: "chat.notice.linksBlocked",
  no_permission: "chat.notice.noPermission",
  usage: "chat.notice.usage",
  invalid_user: "chat.notice.invalidUser",
  unrecognized_cmd: "chat.notice.unrecognizedCommand",
  cmd_success: "chat.notice.commandDone",
  slow_on: "chat.notice.slowOn",
  slow_off: "chat.notice.slowOff",
  followers_on: "chat.notice.followersOn",
  followers_off: "chat.notice.followersOff",
  subs_on: "chat.notice.subsOn",
  subs_off: "chat.notice.subsOff",
  emote_only_on: "chat.notice.emoteOnlyOn",
  emote_only_off: "chat.notice.emoteOnlyOff",
};

/** Error frame codes services/chat sends; anything else gets the generic message. */
const ERRORS: Record<string, MessageKey> = {
  bad_request: "chat.error.badRequest",
  channel_not_found: "chat.error.channelNotFound",
  too_many_rooms: "chat.error.tooManyRooms",
  rate_limited: "chat.error.rateLimited",
  internal_error: "chat.error.generic",
};

export function noticeMessage(code: string): string {
  const key = (NOTICES as Record<string, MessageKey | undefined>)[code];
  return t(key ?? "chat.notice.generic");
}

export function errorMessage(code: string): string {
  return t(ERRORS[code] ?? "chat.error.generic");
}
