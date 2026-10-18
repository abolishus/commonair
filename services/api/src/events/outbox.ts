// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transactional outbox. Handlers call `emit` inside the transaction that made the
 * change; the worker relays unpublished rows to Valkey (BUS.events), webhooks and
 * EventSub. Handlers never publish domain events directly.
 */
import { EVENTS, type EventPayload, type EventType } from "@commonair/contracts/events";
import { schema, uuidv7, type Executor } from "@commonair/db";

export async function emit<T extends EventType>(
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

export const moderatorFields = (u: { id: string; username: string; name: string }) => ({
  moderator_user_id: u.id,
  moderator_user_login: u.username,
  moderator_user_name: u.name,
});
