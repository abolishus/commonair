// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Outbox writes for interactivity, shared by the API and the worker (the same rules as
 * `services/api/src/events/outbox.ts`, which the worker cannot import). Call `emitEvent` inside
 * the transaction that made the change; the worker's relay publishes the row.
 */
import { EVENTS, type EventPayload, type EventType } from "@commonair/contracts/events";
import { schema, uuidv7, type Executor, type LoyaltyReason } from "@commonair/db";

export async function emitEvent<T extends EventType>(
  tx: Executor,
  type: T,
  channelId: string | null,
  payload: EventPayload<T>,
  occurredAt: Date = new Date(),
): Promise<string> {
  const def = EVENTS[type];
  // Validate against the catalog so a malformed payload fails the write, not the subscriber.
  const parsed = def.payload.parse(payload) as Record<string, unknown>;
  const id = uuidv7(occurredAt.getTime());
  await tx.insert(schema.events).values({ id, type, version: def.version, channelId, payload: parsed, occurredAt });
  return id;
}

/** EventSub's broadcaster fields for a channel (login = slug, name = display name). */
export const broadcasterFields = (c: { ownerId: string; slug: string; displayName: string }) => ({
  broadcaster_user_id: c.ownerId,
  broadcaster_user_login: c.slug,
  broadcaster_user_name: c.displayName,
});

export const userFields = (u: { id: string; username: string; name: string }) => ({
  user_id: u.id,
  user_login: u.username,
  user_name: u.name,
});

/** `channel.points.change` for one ledger row (never for `watch`: passive accrual emits nothing). */
export const pointsChangePayload = (
  channel: { ownerId: string; slug: string; displayName: string },
  user: { id: string; username: string; name: string },
  p: { delta: number; balance: number; reason: LoyaltyReason },
): EventPayload<"channel.points.change"> => ({
  ...broadcasterFields(channel),
  ...userFields(user),
  delta: p.delta,
  balance: p.balance,
  reason: p.reason,
});
