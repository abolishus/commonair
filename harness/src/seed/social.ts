// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-social: accounts, channels, follows, chat and the rows every other unit builds on. Brief: `.claude/briefs/seed-full/seed-social.md`. */
import { hashPassword } from "@commonair/db/demo";
import { SeedSessions, createEmotes, seedPortability } from "./social/api.ts";
import { CHAT_HORIZON_DAYS, planSocial, storeEntries } from "./social/plan.ts";
import { chatWindowsForStore, writeChat, writeSocialBase } from "./social/write.ts";
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "users",
  "accounts",
  "sessions",
  "two_factors",
  "passkeys",
  "categories",
  "channels",
  "channel_panels",
  "channel_roles",
  "channel_sub_tiers",
  "follows",
  "stream_keys",
  "chat_messages",
  "chat_bans",
  "user_blocks",
  "emotes",
  "word_filters",
  "legal_acceptances",
  "consent_records",
  "events",
  "audit_log",
  // Batch 7: move links and portability grants.
  "move_links",
  "follow_portability_grants",
] as const;

/** What seed-social publishes as `store.extra.social` (the keys its brief names). */
export interface SocialExtra {
  /** Every streamer's broadcast-shaped windows; chat fills the ones inside the retention horizon. */
  chatWindows: { channelId: string; start: Date; end: Date }[];
  /** Ids of the seeded categories (the first ones carry channels, the last stay empty). */
  categoryIds: string[];
  botUserId: string;
  /** Nonce of streamer1's active move link (`/m/<slug>/<nonce>`). */
  moveLinkNonce: string;
}

export const unit: SeedUnit = {
  name: "social",
  after: [],
  tables: TABLES,
  pending: [],
  async run(ctx) {
    if (ctx.store.users.length > 0 || ctx.store.channels.length > 0)
      throw new Error("seed-social: the store already has users; seed-social runs first, once");
    const started = Date.now();
    const progress = (line: string) => ctx.log.info(`seed-social: ${line}`);
    const plan = planSocial(ctx.rng, ctx.scale, ctx.now);
    // One scrypt hash for every credential account (hashing is the slow part).
    const passwordHash = await hashPassword(ctx.password);
    const base = await writeSocialBase(ctx.db, plan, { passwordHash, signal: ctx.signal, progress });
    const { ids, rows } = base;
    const entries = storeEntries(plan, ids);
    ctx.store.users.push(...entries.users);
    ctx.store.channels.push(...entries.channels);
    progress(`base rows in ${((Date.now() - started) / 1000).toFixed(1)} s`);

    const sessions = new SeedSessions(ctx.env, ctx.password, new Map(plan.accounts.map((a) => [a.handle, a])));
    const emotes = await createEmotes(sessions, plan, ctx.signal);
    rows.emotes = [...emotes.values()].reduce((n, m) => n + m.size, 0);
    rows.chat_messages = await writeChat(ctx.db, plan, ids, emotes, ctx.rng.fork("lines"), {
      signal: ctx.signal,
      progress,
    });
    const portability = await seedPortability(sessions, plan, ctx.signal);
    for (const [table, n] of Object.entries(portability.rows)) rows[table] = (rows[table] ?? 0) + n;

    const bot = plan.accounts.find((a) => a.kind === "bot");
    const botUserId = bot ? ids.users.get(bot.handle) : undefined;
    if (!botUserId) throw new Error("seed-social: the bot account was not created");
    const extra: SocialExtra = {
      chatWindows: chatWindowsForStore(plan.chatWindows, ids),
      categoryIds: plan.categories.flatMap((c) => {
        const id = ids.categories.get(c.slug);
        return id ? [id] : [];
      }),
      botUserId,
      moveLinkNonce: portability.moveLinkNonce,
    };
    ctx.store.extra.social = { ...extra };

    return {
      rows,
      notes: [
        ...base.notes,
        `seed-social: chat is backdated only inside the last ${CHAT_HORIZON_DAYS} days (the worker's chat retention deletes older chat without a VOD); chatWindows older than that carry no chat`,
        "seed-social: chat_messages.broadcast_id is null; seed-media's broadcasts align to chatWindows, and chat replay of a backdated broadcast needs broadcast_id set on the lines inside its window",
        "seed-social: two_factors rows are unverified enrollments (users.two_factor_enabled false), so admin and viewer1 still sign in with the shared password; passkeys are synthetic and only display",
        "seed-social: users.banned is not set on `banned`: the suspension flow (seed-safety's account_actions, through the API) sets it, and setting it first would block the sign-in that files the appeal",
        "seed-social: the bot (bot1) has no credential account and no channel, as `me.bots.create` makes it; every human has a channel, as signup's ensureChannel does, and store.channels lists the streamers' only",
        "seed-social: emotes exist only on the fixed streamers' channels (created through the upload pipeline, so the images are in the media bucket); there are no global emotes",
        "seed-social: events rows come only from the API calls (move links, follows through a link, grants, moved notice) and from the later units' API calls; the direct inserts write none",
        `seed-social: ${sessions.signedIn} accounts signed in through the API (each adds a real session row)`,
      ],
    };
  },
};
