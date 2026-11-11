// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-platform's database side, as the app role: the read-only snapshot the plan works from, and
 * the direct inserts into plain tables (notifications, preferences, go-live send history, the
 * go-live email queue, Discord webhooks, one long-lived device code). No `events` rows: demo data
 * must not fan out. Multi-row inserts are chunked and check the abort signal between chunks.
 */
import { type DbHandle, schema, uuidv7 } from "@commonair/db";
import { normalizeUserCode } from "@commonair/contracts/oauth";
import { NOTIFY_SECRET_PURPOSES } from "@commonair/contracts/notify";
import { encryptSecret, randomTokenSecret, sha256Hex } from "@commonair/tokens";
import type { SeedStore } from "../types.ts";
import {
  DAY_MS,
  type DiscordSpec,
  type EmailQueueSpec,
  type PlatformPlan,
  type PlatformWorld,
  type WorldUser,
} from "./plan.ts";

export const CHUNK = 1_000;

export interface WriteOptions {
  signal?: AbortSignal;
}

async function insertChunks<T>(rows: readonly T[], insert: (chunk: T[]) => Promise<unknown>, o: WriteOptions) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    o.signal?.throwIfAborted();
    await insert(rows.slice(i, i + CHUNK));
  }
  return rows.length;
}

const idOf = (ids: ReadonlyMap<string, string>, handle: string): string => {
  const id = ids.get(handle);
  if (!id) throw new Error(`seed-platform: no user id for "${handle}"`);
  return id;
};

/** What the plan reads: the store's accounts with their real creation times, channels, follows, broadcasts, proposals. */
export async function readWorld(h: DbHandle, store: SeedStore): Promise<PlatformWorld> {
  const q = h.sql;
  const byId = new Map(store.users.map((u) => [u.id, u]));
  const ids = store.users.map((u) => u.id);
  const users: WorldUser[] = [];
  const channels: PlatformWorld["channels"] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    for (const r of await q<
      { id: string; created_at: Date | string }[]
    >`select id, created_at from users where id in ${q(chunk)}`) {
      const u = byId.get(r.id);
      if (u) users.push({ handle: u.handle, id: u.id, kind: u.kind, createdAt: new Date(r.created_at) });
    }
    for (const r of await q<{ id: string; owner_id: string; slug: string; created_at: Date | string }[]>`
      select id, owner_id, slug, created_at from channels where owner_id in ${q(chunk)}`) {
      const u = byId.get(r.owner_id);
      if (u) channels.push({ ownerHandle: u.handle, id: r.id, slug: r.slug, createdAt: new Date(r.created_at) });
    }
  }
  const order = new Map(store.users.map((u, i) => [u.id, i]));
  users.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  channels.sort((a, b) => a.slug.localeCompare(b.slug));

  const none = "00000000-0000-0000-0000-000000000000";
  const fixedIds = store.users.filter((u) => u.kind === "fixed").map((u) => u.id);
  const s1 = channels.find((c) => c.ownerHandle === "streamer1");
  const followRows = await q<{ follower_id: string; channel_id: string; created_at: Date | string; notify: boolean }[]>`
    select follower_id, channel_id, created_at, notify from follows
    where follower_id in ${q(fixedIds.length > 0 ? fixedIds : [none])} or channel_id = ${s1?.id ?? none}`;
  const follows = followRows
    .flatMap((r) => {
      const u = byId.get(r.follower_id);
      return u
        ? [{ followerHandle: u.handle, channelId: r.channel_id, createdAt: new Date(r.created_at), notify: r.notify }]
        : [];
    })
    .sort((a, b) => a.followerHandle.localeCompare(b.followerHandle) || a.channelId.localeCompare(b.channelId));

  const broadcasts = (
    await q<{ id: string; channel_id: string; title: string; started_at: Date | string }[]>`
      select id, channel_id, title, started_at from broadcasts where ended_at is not null
      order by started_at desc, id limit 500`
  ).map((r) => ({ id: r.id, channelId: r.channel_id, title: r.title, startedAt: new Date(r.started_at) }));
  const proposals = await q<{ id: string }[]>`select id from proposals order by id limit 50`;
  // seed-safety's restricted accounts, when it ran: the plan never acts as them.
  const restricted = store.extra.safety?.["restrictedUserIds"];
  const restrictedUserIds = Array.isArray(restricted)
    ? restricted.filter((x): x is string => typeof x === "string")
    : [];
  return { users, channels, follows, broadcasts, proposalIds: proposals.map((p) => p.id), restrictedUserIds };
}

/** A public, ready VOD of a channel (the federation activity toggles its visibility), or null. */
export async function publicVodOf(h: DbHandle, channelId: string): Promise<{ id: string } | null> {
  const [row] = await h.sql<{ id: string }[]>`
    select id from vods where channel_id = ${channelId} and status = 'ready' and visibility = 'public'
    order by created_at desc limit 1`;
  return row ?? null;
}

/** The go-live email digest window (the `notifications.goLive` governance setting), in minutes. */
export async function emailDigestMinutes(h: DbHandle): Promise<number> {
  const [row] = await h.sql<
    { value: unknown }[]
  >`select value from governance_settings where key = 'notifications.goLive'`;
  const v = (row?.value as { emailDigestMinutes?: unknown } | undefined)?.emailDigestMinutes;
  if (typeof v !== "number")
    throw new Error("seed-platform: governance setting notifications.goLive has no emailDigestMinutes");
  return v;
}

/** Notifications, preferences and go-live send history (plain tables). */
export async function writeNotificationRows(
  h: DbHandle,
  plan: Pick<PlatformPlan, "notifications" | "preferences" | "goLiveSends" | "digestSends">,
  ids: ReadonlyMap<string, string>,
  o: WriteOptions = {},
): Promise<Record<string, number>> {
  const db = h.db;
  const notifications = await insertChunks(
    plan.notifications,
    (chunk) =>
      db.insert(schema.notifications).values(
        chunk.map((n) => ({
          id: uuidv7(),
          userId: idOf(ids, n.user),
          type: n.type,
          payload: n.payload,
          createdAt: n.createdAt,
          readAt: n.readAt,
        })),
      ),
    o,
  );
  const prefs = await insertChunks(
    plan.preferences,
    (chunk) =>
      db.insert(schema.notificationPreferences).values(
        chunk.map((p) => ({
          id: uuidv7(),
          userId: idOf(ids, p.user),
          type: p.type ?? "go_live",
          channelId: p.channelId,
          medium: p.medium,
          enabled: p.enabled,
          updatedAt: p.updatedAt,
        })),
      ),
    o,
  );
  // The worker already wrote a real send for followers of the channels that went live earlier in
  // the seed (one row per user and channel): keep those, and count only the rows added here.
  let sends = 0;
  await insertChunks(
    plan.goLiveSends,
    async (chunk) => {
      const added = await db
        .insert(schema.notificationGoLiveSends)
        .values(
          chunk.map((s) => ({
            userId: idOf(ids, s.user),
            channelId: s.channelId,
            lastSentAt: s.lastSentAt,
            eventId: uuidv7(),
          })),
        )
        .onConflictDoNothing()
        .returning({ userId: schema.notificationGoLiveSends.userId });
      sends += added.length;
    },
    o,
  );
  const digestSends = await insertChunks(
    plan.digestSends,
    (chunk) =>
      db
        .insert(schema.notificationDigestSends)
        .values(chunk.map((d) => ({ userId: idOf(ids, d.user), weekStart: d.weekStart }))),
    o,
  );
  return {
    notifications,
    notification_preferences: prefs,
    notification_go_live_sends: sends,
    notification_digest_sends: digestSends,
  };
}

/**
 * Go-live email rows, already due: queued just over the digest window ago, and well inside the
 * stale cut-off, so the worker's next sweep (every 30 s) mails one digest and deletes them.
 */
export async function writeEmailQueue(
  h: DbHandle,
  rows: readonly EmailQueueSpec[],
  ids: ReadonlyMap<string, string>,
  queuedAt: Date,
): Promise<number> {
  if (rows.length === 0) return 0;
  await h.db.insert(schema.notificationEmailQueue).values(
    rows.map((r) => ({
      userId: idOf(ids, r.user),
      eventId: uuidv7(),
      channelId: r.channelId,
      broadcastId: r.broadcastId,
      queuedAt,
    })),
  );
  return rows.length;
}

/** Rows of `user` still in the email queue. */
export async function queuedEmails(h: DbHandle, userId: string): Promise<number> {
  const rows = await h.sql<
    { n: number }[]
  >`select count(*)::int as n from notification_email_queue where user_id = ${userId}`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Discord webhooks pointing at the local sink. The API accepts discord.com URLs only, so these are
 * inserted directly (a plain table), encrypted as the API stores them.
 */
export async function writeDiscordWebhooks(
  h: DbHandle,
  rows: readonly DiscordSpec[],
  ids: ReadonlyMap<string, string>,
  opts: { authSecret: string; sinkOrigin: string },
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = [];
  for (const r of rows)
    values.push({
      channelId: r.channelId,
      url: await encryptSecret(
        opts.authSecret,
        NOTIFY_SECRET_PURPOSES.discordWebhook,
        `${opts.sinkOrigin}${r.sinkPath}`,
      ),
      setBy: idOf(ids, r.owner),
      setAt: r.setAt,
      lastPostedAt: r.lastPostedAt,
      failures: r.failures,
      lastError: r.lastError,
      updatedAt: r.lastPostedAt ?? r.setAt,
    });
  await h.db.insert(schema.discordWebhooks).values(values);
  return values.length;
}

/** RFC 8628 §6.1 user-code alphabet (20 consonants), as the API mints them. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** A user code from `crypto` (it authorizes a device: never from the seed's PRNG). `XXXX-XXXX`. */
export function newUserCode(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  let out = "";
  while (out.length < 8)
    for (const b of random(16)) {
      if (b >= 240) continue; // 240 = 12 × 20: no modulo bias.
      out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
      if (out.length === 8) break;
    }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * A pending device authorization that outlives the coverage run (`oauth_device_codes` is plain).
 * The API's own codes live ten minutes; this one is what `/activate` opens. The device code itself
 * is thrown away: nothing polls it.
 */
export async function insertDeviceCode(
  h: DbHandle,
  input: { appId: string; scopes: string[]; now: Date; expiresInDays: number },
): Promise<{ userCode: string }> {
  const userCode = newUserCode();
  await h.db.insert(schema.oauthDeviceCodes).values({
    id: uuidv7(),
    appId: input.appId,
    deviceCodeHash: await sha256Hex(randomTokenSecret("cad_")),
    userCodeHash: await sha256Hex(normalizeUserCode(userCode)),
    scopes: input.scopes,
    intervalSeconds: 5,
    expiresAt: new Date(input.now.getTime() + input.expiresInDays * DAY_MS),
    createdAt: input.now,
  });
  return { userCode };
}

/** Row counts of `tables` (to report what the API-driven steps really wrote, as before/after deltas). */
export async function tableCounts(h: DbHandle, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    if (!/^[a-z_]+$/.test(t)) throw new Error(`seed-platform: bad table name ${t}`);
    const rows = await h.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t}`);
    out[t] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

/** webhook_deliveries of `subscriptionIds` by state: delivered, failed for good, failed with a retry scheduled. */
export async function deliveryStates(
  h: DbHandle,
  subscriptionIds: readonly string[],
): Promise<{ delivered: number; failed: number; retrying: number }> {
  if (subscriptionIds.length === 0) return { delivered: 0, failed: 0, retrying: 0 };
  const rows = await h.sql<{ status: string; next_attempt_at: Date | string | null }[]>`
    select status, next_attempt_at from webhook_deliveries where subscription_id in ${h.sql([...subscriptionIds])}`;
  return classifyDeliveries(
    rows.map((r) => ({
      status: r.status,
      nextAttemptAt: r.next_attempt_at === null ? null : new Date(r.next_attempt_at),
    })),
  );
}

/** Pure: `retrying` is a failed attempt with another one scheduled. */
export function classifyDeliveries(rows: readonly { status: string; nextAttemptAt: Date | null }[]) {
  let delivered = 0;
  let failed = 0;
  let retrying = 0;
  for (const r of rows)
    if (r.status === "succeeded") delivered++;
    else if (r.status === "failed" && r.nextAttemptAt !== null) retrying++;
    else if (r.status === "failed") failed++;
  return { delivered, failed, retrying };
}
