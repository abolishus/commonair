// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-social's direct inserts, as the app role. Rows have the shapes the API and better-auth write
 * (the demo seed's shapes: credential accounts, hashed stream keys, mod_actions plus audit rows with
 * ids only). No `events` rows: demo data must not fan out. Every multi-row insert is chunked
 * (`CHUNK` rows) and checks the abort signal between chunks.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type DbHandle, schema, uuidv7 } from "@commonair/db";
import type { EmoteRange } from "@commonair/contracts/shapes";
import type { Rng } from "../prng.ts";
import { type ChatWindowSpec, type SocialPlan, chatLines, chatPools } from "./plan.ts";

export const CHUNK = 1_000;
const PROGRESS_MS = 10_000;

export interface SocialIds {
  users: Map<string, string>;
  channels: Map<string, string>;
  categories: Map<string, string>;
}

export interface WriteOptions {
  signal?: AbortSignal;
  /** Progress lines (every 10 s on long inserts). */
  progress?: (line: string) => void;
}

type Rows = Record<string, number>;

/** Legal documents as the API ranks them: newest `publishedAt`, final before draft, then version. */
interface LegalRow {
  id: string;
  kind: string;
  version: string;
  isDraft: boolean;
  requiresAcceptance: boolean;
  publishedAt: Date;
}

/** The current document of each kind on `now` (the API's `latestDocuments`). Pure. */
export function currentLegalDocuments(rows: readonly LegalRow[], now: Date): LegalRow[] {
  const byKind = new Map<string, LegalRow>();
  const newer = (a: LegalRow, b: LegalRow) =>
    a.publishedAt.getTime() !== b.publishedAt.getTime()
      ? a.publishedAt.getTime() > b.publishedAt.getTime()
      : a.isDraft !== b.isDraft
        ? !a.isDraft
        : a.version > b.version;
  for (const r of rows) {
    if (r.publishedAt.getTime() > now.getTime()) continue;
    const cur = byKind.get(r.kind);
    if (!cur || newer(r, cur)) byKind.set(r.kind, r);
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function insertChunks<T>(
  label: string,
  rows: readonly T[],
  insert: (chunk: T[]) => Promise<unknown>,
  o: WriteOptions,
): Promise<number> {
  let last = Date.now();
  for (let i = 0; i < rows.length; i += CHUNK) {
    o.signal?.throwIfAborted();
    await insert(rows.slice(i, i + CHUNK));
    if (o.progress && Date.now() - last > PROGRESS_MS) {
      o.progress(`${label}: ${Math.min(rows.length, i + CHUNK)}/${rows.length}`);
      last = Date.now();
    }
  }
  return rows.length;
}

function need(m: ReadonlyMap<string, string>, key: string, what: string): string {
  const v = m.get(key);
  if (!v) throw new Error(`seed-social: no ${what} for "${key}"`);
  return v;
}

/**
 * Everything except chat (which needs the emote ids the API returns) and the API-only rows. Returns
 * the ids it minted and the rows it wrote per table.
 */
export async function writeSocialBase(
  h: DbHandle,
  plan: SocialPlan,
  opts: WriteOptions & { passwordHash: string },
): Promise<{ ids: SocialIds; rows: Rows; notes: string[] }> {
  const { db } = h;
  const rows: Rows = {};
  const notes: string[] = [];
  const add = (table: string, n: number) => {
    rows[table] = (rows[table] ?? 0) + n;
  };
  const ids: SocialIds = { users: new Map(), channels: new Map(), categories: new Map() };
  const user = (handle: string) => need(ids.users, handle, "user");
  const channel = (handle: string) => need(ids.channels, handle, "channel");

  // Users, then better-auth credential accounts (providerId "credential", accountId = user id).
  for (const a of plan.accounts) ids.users.set(a.handle, uuidv7(a.createdAt.getTime()));
  const humans = plan.accounts.filter((a) => a.kind !== "bot");
  // Owners before their bots (self-referencing foreign key).
  const ordered = [...humans, ...plan.accounts.filter((a) => a.kind === "bot")];
  add(
    "users",
    await insertChunks(
      "users",
      ordered,
      (chunk) =>
        db.insert(schema.users).values(
          chunk.map((a) => ({
            id: user(a.handle),
            name: a.displayName,
            email: a.email,
            // As `me.bots.create`: bots never verify an email or sign in with a password.
            emailVerified: a.kind !== "bot",
            username: a.username,
            displayUsername: a.username,
            role: a.platformRole,
            accountType: a.kind === "bot" ? ("bot" as const) : ("human" as const),
            botOwnerId: a.botOwner ? user(a.botOwner) : null,
            birthDate: a.birthDate,
            locale: a.locale,
            matureConfirmedAt: a.matureConfirmedAt,
            shareEmailWithFollowedChannels: a.shareEmail,
            createdAt: a.createdAt,
            updatedAt: a.createdAt,
          })),
        ),
      opts,
    ),
  );
  add(
    "accounts",
    await insertChunks(
      "accounts",
      humans,
      (chunk) =>
        db.insert(schema.accounts).values(
          chunk.map((a) => ({
            userId: user(a.handle),
            accountId: user(a.handle),
            providerId: "credential",
            password: opts.passwordHash,
            createdAt: a.createdAt,
            updatedAt: a.createdAt,
          })),
        ),
      opts,
    ),
  );

  // Legal acceptances of the current required documents, as at signup (never before publication).
  const legal = currentLegalDocuments(await db.select().from(schema.legalDocuments), plan.now);
  const required = legal.filter((d) => d.requiresAcceptance);
  if (required.length === 0)
    notes.push("seed-social: no legal documents require acceptance; legal_acceptances is empty");
  const acceptances = humans.flatMap((a) =>
    required.map((d) => ({
      userId: user(a.handle),
      documentId: d.id,
      acceptedAt: new Date(Math.max(a.createdAt.getTime(), d.publishedAt.getTime())),
    })),
  );
  add(
    "legal_acceptances",
    await insertChunks("legal_acceptances", acceptances, (c) => db.insert(schema.legalAcceptances).values(c), opts),
  );

  // Categories (shared rows: reuse any that exist by slug).
  await db.insert(schema.categories).values(plan.categories).onConflictDoNothing({ target: schema.categories.slug });
  const wanted = new Set(plan.categories.map((c) => c.slug));
  for (const c of await db.select({ id: schema.categories.id, slug: schema.categories.slug }).from(schema.categories))
    if (wanted.has(c.slug)) ids.categories.set(c.slug, c.id);
  add("categories", ids.categories.size);

  // Channels: every human gets one (as `ensureChannel` at signup); streamers get the full set.
  for (const c of plan.channels) ids.channels.set(c.ownerHandle, uuidv7(c.createdAt.getTime()));
  add(
    "channels",
    await insertChunks(
      "channels",
      plan.channels,
      (chunk) =>
        db.insert(schema.channels).values(
          chunk.map((c) => ({
            id: channel(c.ownerHandle),
            ownerId: user(c.ownerHandle),
            slug: c.slug,
            displayName: c.displayName,
            title: c.title,
            description: c.description,
            categoryId: c.category ? (ids.categories.get(c.category) ?? null) : null,
            tags: c.tags,
            language: c.language,
            createdAt: c.createdAt,
            updatedAt: c.createdAt,
          })),
        ),
      opts,
    ),
  );
  const streamers = plan.channels.filter((c) => c.streamer);
  const panels = streamers.flatMap((c) =>
    c.panels.map((p, position) => ({ channelId: channel(c.ownerHandle), position, ...p, createdAt: c.createdAt })),
  );
  add(
    "channel_panels",
    await insertChunks("channel_panels", panels, (x) => db.insert(schema.channelPanels).values(x), opts),
  );
  const tiers = streamers.flatMap((c) => c.tiers.map((t) => ({ channelId: channel(c.ownerHandle), ...t })));
  add(
    "channel_sub_tiers",
    await insertChunks("channel_sub_tiers", tiers, (x) => db.insert(schema.channelSubTiers).values(x), opts),
  );

  type Audit = typeof schema.auditLog.$inferInsert;
  const audits: Audit[] = [];

  // Word filters, with the audit row `chat.filters.create` writes.
  const filters = streamers.flatMap((c) =>
    c.wordFilters.map((f) => ({ id: uuidv7(), channelId: channel(c.ownerHandle), owner: c.ownerHandle, ...f })),
  );
  if (filters.length > 0) {
    await db.insert(schema.wordFilters).values(filters.map(({ owner: _o, ...f }) => f));
    for (const f of filters)
      audits.push({
        actorType: "moderator",
        actorId: user(f.owner),
        action: "chat.filter.create",
        subjectType: "word_filter",
        subjectId: f.id,
        channelId: f.channelId,
        details: { action: f.action, isRegex: f.isRegex },
      });
  }
  add("word_filters", filters.length);

  // One active stream key per streamer, hashed like `stream.rotateKey`; the secret is discarded.
  const keys = streamers.map((c) => {
    const secret = `live_${randomBytes(32).toString("base64url")}`;
    return {
      id: uuidv7(),
      channelId: channel(c.ownerHandle),
      owner: c.ownerHandle,
      keyHash: sha256Hex(secret),
      prefix: secret.slice(0, 12),
    };
  });
  add(
    "stream_keys",
    await insertChunks(
      "stream_keys",
      keys,
      (x) => db.insert(schema.streamKeys).values(x.map(({ owner: _o, ...k }) => k)),
      opts,
    ),
  );
  for (const k of keys)
    audits.push({
      actorType: "user",
      actorId: user(k.owner),
      action: "stream_key.rotate",
      subjectType: "stream_key",
      subjectId: k.id,
      channelId: k.channelId,
      details: { revoked: [] },
    });

  // Channel roles as `channels.roles.add` records them (mod action for moderator and VIP only).
  type ModAction = typeof schema.modActions.$inferInsert;
  const modActions: ModAction[] = [];
  const roleRows = plan.roles.map((r) => ({
    channelId: channel(r.channel),
    userId: user(r.user),
    role: r.role,
    grantedBy: user(r.grantedBy),
  }));
  if (roleRows.length > 0) await db.insert(schema.channelRoles).values(roleRows);
  for (const r of roleRows) {
    if (r.role !== "editor")
      modActions.push({
        scope: "channel",
        channelId: r.channelId,
        moderatorId: r.grantedBy,
        targetUserId: r.userId,
        action: r.role === "moderator" ? "add_moderator" : "add_vip",
      });
    audits.push({
      actorType: "user",
      actorId: r.grantedBy,
      action: "channel.role.add",
      subjectType: "user",
      subjectId: r.userId,
      channelId: r.channelId,
      details: { role: r.role },
    });
  }
  add("channel_roles", roleRows.length);

  // Follows (the trigger keeps `channels.follower_count`).
  add(
    "follows",
    await insertChunks(
      "follows",
      plan.follows,
      (chunk) =>
        db.insert(schema.follows).values(
          chunk.map((f) => ({
            followerId: user(f.follower),
            channelId: channel(f.channel),
            notify: f.notify,
            createdAt: f.createdAt,
          })),
        ),
      opts,
    ),
  );

  const blocks = plan.blocks.map((b) => ({
    userId: user(b.user),
    blockedUserId: user(b.blocked),
    createdAt: b.createdAt,
  }));
  if (blocks.length > 0) await db.insert(schema.userBlocks).values(blocks);
  add("user_blocks", blocks.length);

  // Chat bans as `chat.bans.ban` writes them: the ban, the mod action and an ids-only audit row.
  for (const b of plan.bans) {
    const banId = uuidv7(b.createdAt.getTime());
    const cid = channel(b.channel);
    const moderatorId = user(b.moderator);
    const target = user(b.target);
    await db.insert(schema.chatBans).values({
      id: banId,
      channelId: cid,
      userId: target,
      moderatorId,
      reason: b.reason,
      expiresAt: b.expiresAt,
      createdAt: b.createdAt,
    });
    modActions.push({
      scope: "channel",
      channelId: cid,
      moderatorId,
      targetUserId: target,
      action: b.durationSeconds === null ? "ban" : "timeout",
      durationSeconds: b.durationSeconds,
      createdAt: b.createdAt,
    });
    audits.push({
      actorType: "moderator",
      actorId: moderatorId,
      action: b.durationSeconds === null ? "chat.ban" : "chat.timeout",
      subjectType: "user",
      subjectId: target,
      channelId: cid,
      details: { banId, durationSeconds: b.durationSeconds },
    });
  }
  add("chat_bans", plan.bans.length);
  if (modActions.length > 0) await db.insert(schema.modActions).values(modActions);
  add("mod_actions", modActions.length);
  // Audit rows keep their real time (append-only); the mod actions carry the backdated time.
  add("audit_log", await insertChunks("audit_log", audits, (x) => db.insert(schema.auditLog).values(x), opts));

  // Sessions: random tokens nobody holds (no IPs: the API disables IP tracking).
  const sessions = plan.sessions.map((s) => ({
    id: uuidv7(s.createdAt.getTime()),
    userId: user(s.user),
    token: randomBytes(32).toString("base64url"),
    expiresAt: s.expiresAt,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
    updatedAt: s.createdAt,
  }));
  add("sessions", await insertChunks("sessions", sessions, (x) => db.insert(schema.sessions).values(x), opts));

  // Two-factor enrollment begun but not verified, so `users.two_factor_enabled` stays false and the
  // shared-password sign-in every unit uses keeps working. Synthetic secret material.
  const twoFactors = plan.twoFactors.map((h) => ({
    userId: user(h),
    secret: randomBytes(32).toString("base64url"),
    backupCodes: randomBytes(96).toString("base64url"),
    verified: false,
  }));
  if (twoFactors.length > 0) await db.insert(schema.twoFactors).values(twoFactors);
  add("two_factors", twoFactors.length);

  // Passkeys in better-auth's stored shape; synthetic keys that only have to display.
  const passkeys = plan.passkeys.map((p) => ({
    name: p.name,
    publicKey: randomBytes(77).toString("base64"),
    userId: user(p.user),
    credentialID: randomBytes(32).toString("base64url"),
    counter: 0,
    deviceType: p.deviceType,
    backedUp: p.backedUp,
    transports: p.transports,
    aaguid: "00000000-0000-0000-0000-000000000000",
    createdAt: p.createdAt,
  }));
  if (passkeys.length > 0) await db.insert(schema.passkeys).values(passkeys);
  add("passkeys", passkeys.length);

  // Consent records against the current cookie policy, as `legal.consent` stores them.
  const cookies = legal.find((d) => d.kind === "cookies");
  if (!cookies) notes.push("seed-social: no cookie policy is published; consent_records is empty");
  const consents = cookies
    ? plan.consents.map((c) => ({
        userId: c.user ? user(c.user) : null,
        // A signed-in record never stores the cookie id (see `legal.consent`).
        anonymousId: c.user ? null : randomUUID(),
        choices: { essential: true, preferences: c.preferences },
        policyVersion: cookies.version,
        createdAt: c.createdAt,
      }))
    : [];
  add(
    "consent_records",
    await insertChunks("consent_records", consents, (x) => db.insert(schema.consentRecords).values(x), opts),
  );

  return { ids, rows, notes };
}

export interface EmoteDef {
  id: string;
  code: string;
  tier: number;
}

/** Chat's emote ranges for `body` (`parseEmotes` in services/chat): whole words matching a usable code. Pure. */
export function emoteRanges(body: string, emotes: ReadonlyMap<string, EmoteDef>, userTier: number): EmoteRange[] {
  const out: EmoteRange[] = [];
  for (const m of body.matchAll(/\S+/gu)) {
    const e = emotes.get(m[0]);
    if (!e || e.tier > userTier) continue;
    out.push({ emoteId: e.id, code: e.code, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Every chat line of every window, streamed in chunks. `emotes` maps an owner handle to its channel's
 * emotes by code (from the API step); a code without an id stays plain text. Returns lines written.
 */
export async function writeChat(
  h: DbHandle,
  plan: SocialPlan,
  ids: SocialIds,
  emotes: ReadonlyMap<string, ReadonlyMap<string, EmoteDef>>,
  rng: Rng,
  opts: WriteOptions = {},
): Promise<number> {
  const pools = chatPools(plan);
  const total = plan.chatWindows.reduce((n, w) => n + w.lines, 0);
  let buffer: (typeof schema.chatMessages.$inferInsert)[] = [];
  let written = 0;
  let last = Date.now();
  const flush = async () => {
    if (buffer.length === 0) return;
    opts.signal?.throwIfAborted();
    await h.db.insert(schema.chatMessages).values(buffer);
    written += buffer.length;
    buffer = [];
    if (opts.progress && Date.now() - last > PROGRESS_MS) {
      opts.progress(`chat_messages: ${written}/${total}`);
      last = Date.now();
    }
  };
  const none = new Map<string, EmoteDef>();
  for (const w of plan.chatWindows) {
    if (w.lines === 0) continue;
    const channelId = need(ids.channels, w.channel, "channel");
    const codes = emotes.get(w.channel) ?? none;
    const lineIds: string[] = [];
    for (const line of chatLines(rng, w, pools)) {
      const id = uuidv7(line.createdAt.getTime());
      lineIds.push(id);
      buffer.push({
        id,
        channelId,
        userId: need(ids.users, line.author, "user"),
        body: line.body,
        emotes: emoteRanges(line.body, codes, line.author === w.channel ? Number.POSITIVE_INFINITY : 0),
        isAction: line.isAction,
        replyToId: line.replyTo === null ? null : (lineIds[line.replyTo] ?? null),
        heldAt: line.held ? line.createdAt : null,
        createdAt: line.createdAt,
      });
      if (buffer.length >= CHUNK) await flush();
    }
  }
  await flush();
  return written;
}

/** `store.extra.social.chatWindows`: every window, with or without chat, by channel id. */
export function chatWindowsForStore(
  windows: readonly ChatWindowSpec[],
  ids: Pick<SocialIds, "channels">,
): { channelId: string; start: Date; end: Date }[] {
  return windows.map((w) => ({ channelId: need(ids.channels, w.channel, "channel"), start: w.start, end: w.end }));
}
