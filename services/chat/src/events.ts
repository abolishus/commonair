// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Event-bus mapping. Accepted chat messages are published straight to BUS.events as
 * `channel.chat.message` (chat volume is too high for the outbox), and a whitelist of
 * platform events is surfaced inline in chat as `{op:"event"}` frames.
 */
import type { BusEvent, dto, EventType } from "@commonair/contracts";
import { chatMessageEventPayload } from "@commonair/contracts/chat";
import { uuidv7 } from "@commonair/db";
import type { ChannelState } from "./types.ts";

export { fragmentsOf } from "@commonair/contracts/chat";

/** The bus envelope around the shared `channel.chat.message` payload. */
export function chatMessageEvent(channel: ChannelState, message: dto.ChatMessage): BusEvent {
  return {
    id: uuidv7(),
    type: "channel.chat.message",
    version: "1",
    channelId: channel.id,
    payload: chatMessageEventPayload(channel, message),
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
