// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Event-bus mapping. Accepted chat messages are published straight to BUS.events as
 * `channel.chat.message` (chat volume is too high for the outbox), and a whitelist of
 * platform events is surfaced inline in chat as `{op:"event"}` frames.
 */
import type { BusEvent, dto, EmoteRange, EventPayload, EventType } from "@commonair/contracts";
import { uuidv7 } from "@commonair/db";
import type { ChannelState } from "./types.ts";

type ChatMessageEvent = EventPayload<"channel.chat.message">;
type Fragment = ChatMessageEvent["message"]["fragments"][number];

const MENTION = /^@[a-z0-9_]{3,25}$/i;

/** Split a body into text / emote / mention fragments (Twitch EventSub shape). */
export function fragmentsOf(body: string, emotes: readonly EmoteRange[]): Fragment[] {
  const out: Fragment[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text, emote: null });
    text = "";
  };
  const sorted = [...emotes].sort((a, b) => a.start - b.start);
  let pos = 0;
  const pushText = (segment: string) => {
    // Mentions are whole words starting with "@"; whitespace stays inside text fragments.
    for (const part of segment.split(/(\s+)/u)) {
      if (MENTION.test(part)) {
        flush();
        out.push({ type: "mention", text: part, emote: null });
      } else text += part;
    }
  };
  for (const e of sorted) {
    if (e.start < pos) continue;
    pushText(body.slice(pos, e.start));
    flush();
    out.push({ type: "emote", text: body.slice(e.start, e.end), emote: { id: e.emoteId } });
    pos = e.end;
  }
  pushText(body.slice(pos));
  flush();
  return out;
}

/** `broadcaster_user_login` is the channel slug, which is always the owner's username. */
export function chatMessageEvent(channel: ChannelState, message: dto.ChatMessage): BusEvent {
  const payload: ChatMessageEvent = {
    broadcaster_user_id: channel.ownerId,
    broadcaster_user_login: channel.slug,
    broadcaster_user_name: channel.displayName,
    chatter_user_id: message.user.id,
    chatter_user_login: message.user.username,
    chatter_user_name: message.user.displayName,
    message_id: message.id,
    message: { text: message.body, fragments: fragmentsOf(message.body, message.emotes) },
    badges: message.user.badges.map((b) => ({ set_id: b.type, id: String(b.tier ?? 1) })),
    color: message.user.color ?? "",
    reply: message.replyTo
      ? {
          parent_message_id: message.replyTo.id,
          parent_user_login: message.replyTo.username,
          parent_message_body: message.replyTo.body,
        }
      : null,
    is_bot: message.user.accountType === "bot",
  };
  return {
    id: uuidv7(),
    type: "channel.chat.message",
    version: "1",
    channelId: channel.id,
    payload,
    occurredAt: message.createdAt,
  };
}

const INLINE_EXACT = new Set<EventType>([
  "channel.subscribe",
  "channel.subscription.gift",
  "channel.tip",
  "channel.raid",
]);

/** Events shown inline in chat (subs, gifts, tips, raids, polls, predictions). */
export const isInlineEvent = (type: string): boolean =>
  INLINE_EXACT.has(type as EventType) || type.startsWith("channel.poll.") || type.startsWith("channel.prediction.");
