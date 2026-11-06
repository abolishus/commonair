// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Event-bus mapping. Accepted chat messages are published straight to BUS.events as
 * `channel.chat.message` (chat volume is too high for the outbox), and a routing table of
 * platform events is surfaced in chat as `{op:"event"}` frames.
 */
import type { BusEvent, dto, EventType } from "@commonair/contracts";
import { chatMessageEventPayload } from "@commonair/contracts/chat";
import { uuidv7 } from "@commonair/db";
import type { Audience } from "./rooms.ts";
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

/**
 * Platform events surfaced in chat as `{op:"event"}` frames, and who receives each. Everyone sees
 * subs, gifts, tips, raids, polls, predictions, giveaways and goals (the pinned strip and inline
 * notices). Follows name the follower, so they go to the broadcaster and moderators only (the
 * dashboard activity feed); a broadcaster's session token carries the moderate scope, so its
 * socket counts as a moderator.
 */
const AUDIENCE_EXACT: ReadonlyMap<string, Audience> = new Map<EventType, Audience>([
  ["channel.subscribe", "all"],
  ["channel.subscription.gift", "all"],
  ["channel.tip", "all"],
  ["channel.raid", "all"],
  ["channel.follow", "moderators"],
]);

const AUDIENCE_PREFIX: readonly (readonly [string, Audience])[] = [
  ["channel.poll.", "all"],
  ["channel.prediction.", "all"],
  ["channel.giveaway.", "all"],
  ["channel.goal.", "all"],
];

/** Who receives an event frame of this type, or null when the event is not shown in chat. */
export function eventAudience(type: string): Audience | null {
  const exact = AUDIENCE_EXACT.get(type);
  if (exact) return exact;
  for (const [prefix, audience] of AUDIENCE_PREFIX) if (type.startsWith(prefix)) return audience;
  return null;
}

/** Events shown in chat to at least some members. */
export const isInlineEvent = (type: string): boolean => eventAudience(type) !== null;
