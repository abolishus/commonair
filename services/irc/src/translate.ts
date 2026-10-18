// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Upstream ServerFrame → Twitch-dialect IRC lines. Pure functions: the session
 * passes in the per-room state they need. Tags are produced in Twitch's
 * (alphabetical) order and the caller strips them when `twitch.tv/tags` is off.
 */
import { EVENTS, type ChannelChatSettings, type ServerFrame } from "@commonair/contracts";
import type { ChatMessage } from "@commonair/contracts/dto";
import { colorTag } from "./colors.ts";
import { SERVER_NAME } from "./constants.ts";
import { emotesTag } from "./emotes.ts";
import { serializeMessage, type OutgoingMessage, type Tags } from "./irc/message.ts";

type Frame<Op extends ServerFrame["op"]> = Extract<ServerFrame, { op: Op }>;

export interface RoomInfo {
  slug: string;
  channelId: string;
}

export const userPrefix = (login: string): string => `${login}!${login}@${login}.${SERVER_NAME}`;
export const ircChannel = (slug: string): string => `#${slug}`;

/** Sort tags by key, as Twitch emits them. */
function ordered(tags: Tags): Tags {
  return Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---------------------------------------------------------------- badges

export interface Badge {
  type: string;
  tier?: number | undefined;
}

const BADGE_ORDER = ["staff", "broadcaster", "moderator", "vip", "subscriber", "bot", "member"];
const BADGE_SET: Readonly<Record<string, string>> = { bot: "bot-badge" };

/** Twitch subscriber badge versions: tier 1 = `0` (tenure-based), tier 2 = `2000`, tier 3 = `3000`. */
const badgeVersion = (b: Badge): string =>
  b.type === "subscriber" ? String(b.tier && b.tier >= 2 ? b.tier * 1000 : 0) : "1";

export function badgesTag(badges: readonly Badge[]): string {
  return [...badges]
    .filter((b) => BADGE_ORDER.includes(b.type))
    .sort((a, b) => BADGE_ORDER.indexOf(a.type) - BADGE_ORDER.indexOf(b.type))
    .map((b) => `${BADGE_SET[b.type] ?? b.type}/${badgeVersion(b)}`)
    .join(",");
}

/** `joined.me.badges` are strings; accept `type`, `type/tier` and `type:tier`. */
export function parseBadgeStrings(badges: readonly string[]): Badge[] {
  return badges.map((s) => {
    const [type = "", tier] = s.split(/[/:]/);
    const n = tier === undefined ? undefined : Number(tier);
    return { type, tier: n !== undefined && Number.isInteger(n) ? n : undefined };
  });
}

const hasBadge = (badges: readonly Badge[], type: string) => badges.some((b) => b.type === type);

// ---------------------------------------------------------------- PRIVMSG

export function privmsg(room: RoomInfo, m: ChatMessage): OutgoingMessage {
  const badges = m.user.badges;
  const tags: Tags = {
    "badge-info": "",
    badges: badgesTag(badges),
    color: colorTag(m.user.color),
    "display-name": m.user.displayName,
    emotes: emotesTag(m.body, m.emotes),
    "first-msg": "0",
    flags: "",
    id: m.id,
    mod: hasBadge(badges, "moderator") ? "1" : "0",
    "returning-chatter": "0",
    "room-id": room.channelId,
    subscriber: hasBadge(badges, "subscriber") ? "1" : "0",
    "tmi-sent-ts": String(Date.parse(m.createdAt)),
    turbo: "0",
    "user-id": m.user.id,
    "user-type": hasBadge(badges, "moderator") ? "mod" : "",
  };
  // Twitch only sends `vip` for VIPs.
  if (hasBadge(badges, "vip")) tags.vip = "1";
  if (m.replyTo) {
    tags["reply-parent-display-name"] = m.replyTo.username;
    tags["reply-parent-msg-body"] = m.replyTo.body;
    tags["reply-parent-msg-id"] = m.replyTo.id;
    tags["reply-parent-user-login"] = m.replyTo.username;
  }
  return {
    tags: ordered(tags),
    prefix: userPrefix(m.user.username),
    command: "PRIVMSG",
    params: [ircChannel(room.slug)],
    trailing: m.isAction ? `\x01ACTION ${m.body}\x01` : m.body,
  };
}

// ---------------------------------------------------------------- room and user state

export function roomstateTags(settings: ChannelChatSettings, channelId: string): Tags {
  return {
    "emote-only": settings.emoteOnly ? "1" : "0",
    "followers-only": settings.followersOnlyMinutes === null ? "-1" : String(settings.followersOnlyMinutes),
    r9k: "0",
    "room-id": channelId,
    slow: String(settings.slowModeSeconds),
    "subs-only": settings.subscribersOnly ? "1" : "0",
  };
}

/** Full ROOMSTATE on join; on change only the changed keys (plus room-id), as Twitch does. Null when nothing changed. */
export function roomstate(
  room: RoomInfo,
  next: ChannelChatSettings,
  prev?: ChannelChatSettings,
): OutgoingMessage | null {
  const all = roomstateTags(next, room.channelId);
  let tags = all;
  if (prev) {
    const before = roomstateTags(prev, room.channelId);
    const changed = Object.entries(all).filter(([k, v]) => k !== "room-id" && before[k] !== v);
    if (changed.length === 0) return null;
    tags = ordered({ ...Object.fromEntries(changed), "room-id": room.channelId });
  }
  return { tags, prefix: SERVER_NAME, command: "ROOMSTATE", params: [ircChannel(room.slug)] };
}

export interface SelfState {
  login: string;
  displayName: string;
  userId: string | null;
  color: string | null;
}

export function userstate(room: RoomInfo, self: SelfState, badges: readonly Badge[], canModerate: boolean) {
  const mod = canModerate && !hasBadge(badges, "broadcaster");
  const tags: Tags = {
    "badge-info": "",
    badges: badgesTag(badges),
    color: colorTag(self.color),
    "display-name": self.displayName,
    "emote-sets": "0",
    mod: mod ? "1" : "0",
    subscriber: hasBadge(badges, "subscriber") ? "1" : "0",
    "user-type": mod ? "mod" : "",
  };
  return { tags, prefix: SERVER_NAME, command: "USERSTATE", params: [ircChannel(room.slug)] } satisfies OutgoingMessage;
}

export function globaluserstate(self: SelfState): OutgoingMessage {
  return {
    tags: {
      "badge-info": "",
      badges: "",
      color: colorTag(self.color),
      "display-name": self.displayName,
      "emote-sets": "0",
      "user-id": self.userId ?? "",
      "user-type": "",
    },
    prefix: SERVER_NAME,
    command: "GLOBALUSERSTATE",
  };
}

// ---------------------------------------------------------------- moderation

export function clearchat(room: RoomInfo, f: Frame<"clear"> | Frame<"ban">, now = Date.now()): OutgoingMessage {
  const tags: Tags = { "room-id": room.channelId, "tmi-sent-ts": String(now) };
  if (f.op === "clear") return { tags, prefix: SERVER_NAME, command: "CLEARCHAT", params: [ircChannel(room.slug)] };
  if (f.expiresAt !== null) {
    const secs = Math.max(1, Math.ceil((Date.parse(f.expiresAt) - now) / 1000));
    tags["ban-duration"] = String(secs);
  }
  tags["target-user-id"] = f.userId;
  return {
    tags: ordered(tags),
    prefix: SERVER_NAME,
    command: "CLEARCHAT",
    params: [ircChannel(room.slug)],
    trailing: f.username,
  };
}

export function clearmsg(room: RoomInfo, f: Frame<"delete">, body: string, now = Date.now()): OutgoingMessage {
  return {
    tags: { login: f.username, "room-id": room.channelId, "target-msg-id": f.messageId, "tmi-sent-ts": String(now) },
    prefix: SERVER_NAME,
    command: "CLEARMSG",
    params: [ircChannel(room.slug)],
    // tmi.js only emits `messagedeleted` when the trailing param is present, even if empty.
    trailing: body,
  };
}

export function notice(target: string, msgId: string | null, text: string): OutgoingMessage {
  return {
    tags: msgId ? { "msg-id": msgId } : {},
    prefix: SERVER_NAME,
    command: "NOTICE",
    params: [target],
    trailing: text,
  };
}

// ---------------------------------------------------------------- USERNOTICE

/** Gifts announced by `channel.subscription.gift`, consumed by the per-recipient `channel.subscribe` events that follow. */
export interface GiftPool {
  login: string;
  displayName: string;
  userId: string;
  remaining: number;
  expiresAt: number;
}

const ANON_GIFTER = { login: "ananonymousgifter", displayName: "AnAnonymousGifter", userId: "" };
const GIFT_POOL_TTL_MS = 60_000;
const planName = (tier: string) => `Tier ${tier.slice(0, 1)}`;

function usernoticeBase(room: RoomInfo, user: { login: string; displayName: string; userId: string }, now: number) {
  return {
    "badge-info": "",
    badges: "",
    color: "",
    "display-name": user.displayName,
    emotes: "",
    flags: "",
    id: crypto.randomUUID(),
    login: user.login,
    mod: "0",
    "room-id": room.channelId,
    subscriber: "0",
    "tmi-sent-ts": String(now),
    "user-id": user.userId,
    "user-type": "",
  } satisfies Tags;
}

function un(room: RoomInfo, tags: Tags, trailing?: string): OutgoingMessage {
  return { tags: ordered(tags), prefix: SERVER_NAME, command: "USERNOTICE", params: [ircChannel(room.slug)], trailing };
}

export interface EventContext {
  giftPool: GiftPool | null;
  now?: number;
}

/**
 * Inline platform events → USERNOTICE (`sub`, `subgift`, `submysterygift`, `raid`, and
 * a CommonAir `tip` extension). Polls and predictions have no IRC form and are dropped.
 * Mutates `ctx.giftPool`.
 */
export function usernotice(room: RoomInfo, f: Frame<"event">, ctx: EventContext): OutgoingMessage | null {
  const now = ctx.now ?? Date.now();
  switch (f.type) {
    case "channel.subscribe": {
      const p = EVENTS["channel.subscribe"].payload.safeParse(f.data);
      if (!p.success) return null;
      const d = p.data;
      const recipient = { login: d.user_login, displayName: d.user_name, userId: d.user_id };
      if (!d.is_gift) {
        return un(room, {
          ...usernoticeBase(room, recipient, now),
          subscriber: "1",
          "msg-id": "sub",
          "msg-param-cumulative-months": "1",
          "msg-param-months": "0",
          "msg-param-should-share-streak": "0",
          "msg-param-sub-plan": d.tier,
          "msg-param-sub-plan-name": planName(d.tier),
          "system-msg": `${d.user_name} subscribed at ${planName(d.tier)}.`,
        });
      }
      const pool = ctx.giftPool && ctx.giftPool.expiresAt > now && ctx.giftPool.remaining > 0 ? ctx.giftPool : null;
      if (pool) pool.remaining--;
      const gifter = pool ?? ANON_GIFTER;
      return un(room, {
        ...usernoticeBase(room, gifter, now),
        "msg-id": "subgift",
        "msg-param-gift-months": "1",
        "msg-param-months": "1",
        "msg-param-origin-id": crypto.randomUUID(),
        "msg-param-recipient-display-name": d.user_name,
        "msg-param-recipient-id": d.user_id,
        "msg-param-recipient-user-name": d.user_login,
        "msg-param-sub-plan": d.tier,
        "msg-param-sub-plan-name": planName(d.tier),
        "system-msg": `${gifter.displayName} gifted a ${planName(d.tier)} sub to ${d.user_name}!`,
      });
    }
    case "channel.subscription.gift": {
      const p = EVENTS["channel.subscription.gift"].payload.safeParse(f.data);
      if (!p.success) return null;
      const d = p.data;
      const gifter =
        d.is_anonymous || !d.user_id || !d.user_login
          ? ANON_GIFTER
          : { login: d.user_login, displayName: d.user_name ?? d.user_login, userId: d.user_id };
      ctx.giftPool = { ...gifter, remaining: d.total, expiresAt: now + GIFT_POOL_TTL_MS };
      return un(room, {
        ...usernoticeBase(room, gifter, now),
        "msg-id": "submysterygift",
        "msg-param-mass-gift-count": String(d.total),
        "msg-param-origin-id": crypto.randomUUID(),
        "msg-param-sub-plan": d.tier,
        "system-msg": `${gifter.displayName} is gifting ${d.total} ${planName(d.tier)} Subs to the community!`,
      });
    }
    case "channel.raid": {
      const p = EVENTS["channel.raid"].payload.safeParse(f.data);
      if (!p.success) return null;
      const d = p.data;
      const from = {
        login: d.from_broadcaster_user_login,
        displayName: d.from_broadcaster_user_name,
        userId: d.from_broadcaster_user_id,
      };
      return un(room, {
        ...usernoticeBase(room, from, now),
        "msg-id": "raid",
        "msg-param-displayName": from.displayName,
        "msg-param-login": from.login,
        "msg-param-viewerCount": String(d.viewers),
        "system-msg": `${d.viewers} raiders from ${from.displayName} have joined!`,
      });
    }
    case "channel.tip": {
      const p = EVENTS["channel.tip"].payload.safeParse(f.data);
      if (!p.success) return null;
      const d = p.data;
      const user =
        d.is_anonymous || !d.user_id || !d.user_login
          ? ANON_GIFTER
          : { login: d.user_login, displayName: d.user_name ?? d.user_login, userId: d.user_id };
      return un(
        room,
        {
          ...usernoticeBase(room, user, now),
          "msg-id": "tip",
          "msg-param-amount": String(d.amount.value),
          "msg-param-currency": d.amount.currency.toUpperCase(),
          "msg-param-exponent": String(d.amount.decimal_places),
          "system-msg": `${user.displayName} sent a tip.`,
        },
        d.message || undefined,
      );
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- helpers

/** Serialize, dropping tags unless the client negotiated `twitch.tv/tags`. */
export function render(msg: OutgoingMessage, withTags: boolean): string {
  return serializeMessage(withTags ? msg : { ...msg, tags: undefined });
}
