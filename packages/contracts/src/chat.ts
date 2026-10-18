// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat WebSocket wire protocol (JSON text frames). services/chat is the only
 * place chat rules are enforced; the IRC gateway translates IRC to this
 * protocol over one upstream connection per IRC client.
 */
import { z } from "zod";
import { ChatMessage } from "./api/entities.ts";
import { ChannelChatSettings } from "./shapes.ts";

const channel = z.string().min(3).max(25);

export const ClientFrame = z.discriminatedUnion("op", [
  z.object({ op: z.literal("join"), channel, nonce: z.string().max(64).optional() }),
  z.object({ op: z.literal("part"), channel, nonce: z.string().max(64).optional() }),
  z.object({
    op: z.literal("send"),
    channel,
    body: z.string().min(1).max(500),
    replyToId: z.uuid().optional(),
    isAction: z.boolean().default(false),
    nonce: z.string().max(64).optional(),
  }),
  /** Moderator commands sent from chat (/ban, /timeout, /slow …); same authorization as the REST API. */
  z.object({
    op: z.literal("command"),
    channel,
    command: z.string().regex(/^[a-z]+$/),
    args: z.array(z.string().max(500)).max(10),
    nonce: z.string().max(64).optional(),
  }),
  z.object({ op: z.literal("ping"), nonce: z.string().max(64).optional() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** Notice codes mirror Twitch IRC `msg-id`s where one exists, so the IRC gateway maps them 1:1. */
export const NOTICE_CODES = [
  "msg_banned",
  "msg_timedout",
  "msg_slowmode",
  "msg_followersonly",
  "msg_subsonly",
  "msg_emoteonly",
  "msg_ratelimit",
  "msg_duplicate",
  "msg_rejected",
  "msg_held",
  "msg_account_too_new",
  "msg_verified_email",
  "msg_channel_suspended",
  "msg_requires_login",
  "msg_links_blocked",
  "no_permission",
  "usage",
  "invalid_user",
  "unrecognized_cmd",
  "cmd_success",
  "slow_on",
  "slow_off",
  "followers_on",
  "followers_off",
  "subs_on",
  "subs_off",
  "emote_only_on",
  "emote_only_off",
] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];

export const ServerFrame = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("welcome"),
    sessionId: z.string(),
    user: z.object({ id: z.uuid(), username: z.string(), displayName: z.string() }).nullable(),
    heartbeatMs: z.number().int(),
  }),
  z.object({
    op: z.literal("joined"),
    channel,
    channelId: z.uuid(),
    settings: ChannelChatSettings,
    me: z.object({ badges: z.array(z.string()), canModerate: z.boolean(), canChat: z.boolean() }),
  }),
  z.object({ op: z.literal("parted"), channel }),
  z.object({
    op: z.literal("message"),
    channel,
    message: ChatMessage,
    /** True for a message held by a word filter (delivered to moderators only). */
    held: z.boolean().optional(),
  }),
  z.object({ op: z.literal("delete"), channel, messageId: z.uuid(), username: z.string() }),
  z.object({ op: z.literal("clear"), channel }),
  z.object({
    op: z.literal("ban"),
    channel,
    userId: z.uuid(),
    username: z.string(),
    expiresAt: z.string().nullable(),
    /** Delivered to moderators only; viewers receive an empty string. */
    reason: z.string(),
  }),
  z.object({ op: z.literal("settings"), channel, settings: ChannelChatSettings }),
  z.object({
    op: z.literal("notice"),
    channel: channel.nullable(),
    code: z.enum(NOTICE_CODES),
    text: z.string(),
  }),
  z.object({
    op: z.literal("ack"),
    nonce: z.string().optional(),
    id: z.uuid().nullable(),
    held: z.boolean(),
  }),
  /** Platform events surfaced inline in chat (subs, tips, raids, polls). */
  z.object({
    op: z.literal("event"),
    channel,
    type: z.string(),
    data: z.record(z.string(), z.unknown()),
  }),
  z.object({ op: z.literal("pong"), nonce: z.string().optional() }),
  z.object({
    op: z.literal("error"),
    code: z.string(),
    message: z.string(),
    /** The channel a failed join/part/send referred to, when there is one. */
    channel: channel.optional(),
    nonce: z.string().optional(),
  }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Rate limits (per user, per channel), Twitch-like: normal users 20 msgs/30s, mods and broadcaster 100/30s, verified bots 7500/30s across channels. */
export const CHAT_LIMITS = {
  windowMs: 30_000,
  user: 20,
  moderator: 100,
  bot: 50,
  botVerified: 7500,
  duplicateWindowMs: 30_000,
  maxBodyLength: 500,
} as const;

/**
 * Messages on BUS.chatControl(channelId): a client-visible control frame (`ban`, `delete`,
 * `clear`, `settings`) every chat instance forwards after updating caches, or an `invalidate`
 * signal (role changes, unbans, follows, subscriptions, emote/filter/suspension edits) that only
 * drops caches. The API publishes these after REST moderation and related writes.
 */
export const InvalidateMessage = z.object({
  op: z.literal("invalidate"),
  scope: z.enum(["channel", "user"]),
  userId: z.uuid().optional(),
});
export type InvalidateMessage = z.infer<typeof InvalidateMessage>;

const CONTROL_OPS = new Set(["ban", "delete", "clear", "settings"]);
export const ChatControlMessage = z.union([
  InvalidateMessage,
  ServerFrame.refine((f) => CONTROL_OPS.has(f.op), "not a control frame"),
]);
export type ChatControlMessage = z.infer<typeof ChatControlMessage>;

/** Fan-out envelope on BUS.chat(channelId). */
export const ChatFanout = z.object({
  v: z.literal(1),
  /** "moderators" for messages held by a word filter. */
  audience: z.enum(["all", "moderators"]),
  /** Publish time (epoch ms) for the fan-out latency histogram. */
  sentAt: z.number(),
  frame: ServerFrame,
});
export type ChatFanout = z.infer<typeof ChatFanout>;
