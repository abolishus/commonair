// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What seed-interact's plan needs from seed-social's rows: the store's accounts and channels, with
 * the creation times (no row may predate an account or channel it references), each channel's
 * moderators and editors (who never bet) and its chat bans in force (who cannot vote, bet or enter).
 * Read-only.
 */
import type { DbHandle } from "@commonair/db";
import type { SeedStore } from "../types.ts";
import type { Roster } from "./plan.ts";

export interface RosterRows {
  users: readonly { id: string; createdAt: Date }[];
  channels: readonly { id: string; createdAt: Date }[];
  roles: readonly { channelId: string; userId: string; role: string }[];
  bans: readonly { channelId: string; userId: string; expiresAt: Date | null }[];
}

/** The plan's roster from the store and the rows read for it. Pure. */
export function buildRoster(store: SeedStore, rows: RosterRows, now: Date): Roster {
  const userCreated = new Map(rows.users.map((u) => [u.id, u.createdAt]));
  const channelCreated = new Map(rows.channels.map((c) => [c.id, c.createdAt]));
  const handleOf = new Map(store.users.map((u) => [u.id, u.handle]));
  const ownerOf = new Map(store.channels.map((c) => [c.id, c.ownerHandle]));
  const users = store.users.map((u) => {
    const createdAt = userCreated.get(u.id);
    if (!createdAt) throw new Error(`seed-interact: user ${u.handle} is in the store but not in the database`);
    return { handle: u.handle, kind: u.kind, platformRole: u.platformRole, createdAt };
  });
  const channels = store.channels.map((c) => {
    const createdAt = channelCreated.get(c.id);
    if (!createdAt) throw new Error(`seed-interact: channel ${c.slug} is in the store but not in the database`);
    return { ownerHandle: c.ownerHandle, createdAt };
  });
  const add = (m: Map<string, Set<string>>, channelId: string, userId: string) => {
    const owner = ownerOf.get(channelId);
    const handle = handleOf.get(userId);
    if (!owner || !handle) return;
    const s = m.get(owner) ?? new Set<string>();
    s.add(handle);
    m.set(owner, s);
  };
  const team = new Map<string, Set<string>>();
  for (const r of rows.roles) if (r.role === "moderator" || r.role === "editor") add(team, r.channelId, r.userId);
  const banned = new Map<string, Set<string>>();
  for (const b of rows.bans)
    if (b.expiresAt === null || b.expiresAt.getTime() > now.getTime()) add(banned, b.channelId, b.userId);
  return { users, channels, team, banned };
}

/** The client may hand timestamps back as text; the plan works with dates. */
const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

type Stamp = Date | string;

/** Read the rows `buildRoster` needs. */
export async function readRoster(h: DbHandle, store: SeedStore, now: Date): Promise<Roster> {
  const ids = store.channels.map((c) => c.id);
  const stamped = (r: readonly { id: string; createdAt: Stamp }[]) =>
    r.map((x) => ({ id: x.id, createdAt: toDate(x.createdAt) }));
  const users = stamped(
    await h.sql<{ id: string; createdAt: Stamp }[]>`select id, created_at as "createdAt" from users`,
  );
  if (ids.length === 0) return buildRoster(store, { users, channels: [], roles: [], bans: [] }, now);
  const channels = stamped(
    await h.sql<{ id: string; createdAt: Stamp }[]>`
      select id, created_at as "createdAt" from channels where id in ${h.sql(ids)}`,
  );
  const roles = await h.sql<{ channelId: string; userId: string; role: string }[]>`
    select channel_id as "channelId", user_id as "userId", role::text as role
      from channel_roles where channel_id in ${h.sql(ids)}`;
  const bans = (
    await h.sql<{ channelId: string; userId: string; expiresAt: Stamp | null }[]>`
      select channel_id as "channelId", user_id as "userId", expires_at as "expiresAt"
        from chat_bans where lifted_at is null and channel_id in ${h.sql(ids)}`
  ).map((b) => ({ ...b, expiresAt: b.expiresAt === null ? null : toDate(b.expiresAt) }));
  return buildRoster(store, { users, channels, roles, bans }, now);
}
