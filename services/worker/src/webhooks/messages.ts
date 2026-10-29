// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { subscriptionEnvelope } from "@commonair/contracts/eventsub";
import {
  signWebhook,
  type SubscriptionEnvelope,
  WEBHOOK_HEADERS,
  WEBHOOK_MESSAGE_TYPES,
} from "@commonair/contracts/events";
import type { schema } from "@commonair/db";
import type { z } from "zod";

export type SubscriptionRow = typeof schema.eventSubscriptions.$inferSelect;
export type MessageType = (typeof WEBHOOK_MESSAGE_TYPES)[number];
export type Envelope = z.infer<typeof SubscriptionEnvelope>;

export { ENVELOPE_STATUS } from "@commonair/contracts/eventsub";
export { notificationMessageId } from "@commonair/db";

export function envelope(sub: SubscriptionRow, status?: string): Envelope {
  return subscriptionEnvelope(sub, status);
}

export async function signedHeaders(input: {
  secret: string;
  messageId: string;
  messageType: MessageType;
  timestamp: string;
  body: string;
  subscription: Pick<SubscriptionRow, "type" | "version">;
  retry: number;
}): Promise<Record<string, string>> {
  return {
    [WEBHOOK_HEADERS.messageId]: input.messageId,
    [WEBHOOK_HEADERS.messageRetry]: String(input.retry),
    [WEBHOOK_HEADERS.messageType]: input.messageType,
    [WEBHOOK_HEADERS.messageTimestamp]: input.timestamp,
    [WEBHOOK_HEADERS.messageSignature]: await signWebhook(input.secret, input.messageId, input.timestamp, input.body),
    [WEBHOOK_HEADERS.subscriptionType]: input.subscription.type,
    [WEBHOOK_HEADERS.subscriptionVersion]: input.subscription.version,
  };
}

/** Keep at most `max` bytes of UTF-8 text without splitting a code point. */
export function truncateUtf8(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  let end = max;
  // Back up over continuation bytes (10xxxxxx) so the cut lands on a boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
