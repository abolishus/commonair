// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Read-through caches over Postgres for channels, users and per-channel standing. TTLs bound
 * staleness if an invalidation on BUS.chatControl is ever missed (pub/sub is at-most-once).
 */
import { and, desc, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { ChannelChatSettings } from "@commonair/contracts";
import { schema, type Database } from "@commonair/db";
import { TtlCache } from "./cache.ts";
import { compileFilters, type CompiledFilter } from "./content.ts";
import { mergeEmotes } from "./emotes.ts";
import type { ChannelState, EmoteDef, Standing, UserProfile } from "./types.ts";

const { users, channels, channelRoles, follows, subscriptions, chatBans, emotes, wordFilters, memberships } = schema;

export interface DirectoryOptions {
  channelTtlMs?: number;
  profileTtlMs?: number;
  standingTtlMs?: number;
  /** How long "no such channel" is remembered (short, so a new channel is joinable quickly). */
  missingTtlMs?: number;
  onInvalidFilter?: (channelId: string, filterId: string, reason: string) => void;
}

export interface LoadedChannel {
  state: ChannelState;
  filters: CompiledFilter[];
}

const SUB_ACTIVE = ["active", "past_due"] as const;

export class Directory {
  private readonly bySlug: TtlCache<string, LoadedChannel | null>;
  private readonly slugById = new Map<string, string>();
  private readonly globalEmotes: TtlCache<"global", EmoteDef[]>;
  private readonly profiles: TtlCache<string, UserProfile | null>;
  private readonly standings: TtlCache<string, Standing>;
  private readonly missing = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly opts: DirectoryOptions = {},
  ) {
    this.bySlug = new TtlCache(opts.channelTtlMs ?? 60_000, 5_000);
    this.globalEmotes = new TtlCache(opts.channelTtlMs ?? 60_000, 1);
    this.profiles = new TtlCache(opts.profileTtlMs ?? 15_000, 50_000);
    this.standings = new TtlCache(opts.standingTtlMs ?? 30_000, 100_000);
  }

  async channel(slug: string): Promise<LoadedChannel | null> {
    const key = slug.toLowerCase();
    const missingUntil = this.missing.get(key);
    if (missingUntil !== undefined) {
      if (missingUntil > Date.now()) return null;
      this.missing.delete(key);
    }
    const loaded = await this.bySlug.get(key, () => this.loadChannel(key));
    if (loaded) return loaded;
    // Misses are not kept in the main cache: a channel created a moment later must be joinable.
    this.bySlug.delete(key);
    if (this.missing.size >= 10_000) this.missing.clear();
    this.missing.set(key, Date.now() + (this.opts.missingTtlMs ?? 5_000));
    return null;
  }

  profile(userId: string): Promise<UserProfile | null> {
    return this.profiles.get(userId, () => this.loadProfile(userId));
  }

  standing(channel: Pick<ChannelState, "id" | "ownerId">, userId: string): Promise<Standing> {
    return this.standings.get(`${channel.id}:${userId}`, () => this.loadStanding(channel, userId));
  }

  async userByUsername(username: string): Promise<{ id: string; username: string; displayName: string } | null> {
    const [row] = await this.db
      .select({ id: users.id, username: users.username, name: users.name, displayUsername: users.displayUsername })
      .from(users)
      .where(and(eq(users.username, username.toLowerCase()), isNull(users.deletedAt)))
      .limit(1);
    return row ? { id: row.id, username: row.username, displayName: row.displayUsername ?? row.name } : null;
  }

  invalidateChannel(channelId: string): void {
    const slug = this.slugById.get(channelId);
    if (slug) this.bySlug.delete(slug);
    this.globalEmotes.clear();
  }

  /**
   * Forget a room's channel and standings (no members left here, so no invalidations will arrive
   * for it); the next join reads Postgres instead of state that may have changed meanwhile.
   */
  evictChannel(channelId: string): void {
    const slug = this.slugById.get(channelId);
    if (slug) this.bySlug.delete(slug);
    this.standings.deleteWhere((k) => k.startsWith(`${channelId}:`));
  }

  invalidateStanding(channelId: string, userId?: string): void {
    if (userId) this.standings.delete(`${channelId}:${userId}`);
    else this.standings.deleteWhere((k) => k.startsWith(`${channelId}:`));
  }

  invalidateProfile(userId: string): void {
    this.profiles.delete(userId);
  }

  /** Drop everything cached about a user, in every channel (BUS.userControl). */
  invalidateUser(userId: string): void {
    this.profiles.delete(userId);
    this.standings.deleteWhere((k) => k.endsWith(`:${userId}`));
  }

  private async loadChannel(slug: string): Promise<LoadedChannel | null> {
    const [row] = await this.db.select().from(channels).where(eq(channels.slug, slug)).limit(1);
    if (!row) return null;
    const [own, global, filters] = await Promise.all([
      this.db
        .select({ id: emotes.id, code: emotes.code, tier: emotes.tier, channelId: emotes.channelId })
        .from(emotes)
        .where(eq(emotes.channelId, row.id)),
      this.globalEmotes.get("global", () =>
        this.db
          .select({ id: emotes.id, code: emotes.code, tier: emotes.tier, channelId: emotes.channelId })
          .from(emotes)
          .where(isNull(emotes.channelId)),
      ),
      this.db
        .select({
          id: wordFilters.id,
          pattern: wordFilters.pattern,
          isRegex: wordFilters.isRegex,
          action: wordFilters.action,
          replacement: wordFilters.replacement,
        })
        .from(wordFilters)
        .where(eq(wordFilters.channelId, row.id)),
    ]);
    const parsed = ChannelChatSettings.safeParse(row.chatSettings);
    const state: ChannelState = {
      id: row.id,
      slug: row.slug,
      ownerId: row.ownerId,
      displayName: row.displayName,
      // A malformed jsonb value falls back to the safe defaults rather than locking chat.
      settings: parsed.success ? parsed.data : ChannelChatSettings.parse({}),
      suspended: row.suspendedAt !== null,
      liveBroadcastId: row.liveBroadcastId,
      emotes: mergeEmotes(global, own),
      filters,
    };
    this.slugById.set(row.id, row.slug);
    return {
      state,
      filters: compileFilters(filters, (f, reason) => this.opts.onInvalidFilter?.(row.id, f.id, reason)),
    };
  }

  private async loadProfile(userId: string): Promise<UserProfile | null> {
    // One statement: every upgrade reads this, and two in parallel need a second pool
    // connection, i.e. a new connect (and name lookup) when only one is warm.
    const activeMembership = this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, users.id), eq(memberships.status, "active")));
    const [found] = await this.db
      .select({ row: users, isMember: sql<boolean>`${exists(activeMembership)}` })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!found) return null;
    const row = found.row;
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayUsername ?? row.name,
      accountType: row.accountType,
      botVerified: row.botVerified,
      platformRole: row.role,
      emailVerified: row.emailVerified,
      createdAt: row.createdAt,
      banned: row.banned,
      banExpires: row.banExpires,
      deleted: row.deletedAt !== null,
      isMember: found.isMember,
    };
  }

  private async loadStanding(channel: Pick<ChannelState, "id" | "ownerId">, userId: string): Promise<Standing> {
    const [roles, follow, sub, ban] = await Promise.all([
      this.db
        .select({ role: channelRoles.role })
        .from(channelRoles)
        .where(and(eq(channelRoles.channelId, channel.id), eq(channelRoles.userId, userId))),
      this.db
        .select({ createdAt: follows.createdAt })
        .from(follows)
        .where(and(eq(follows.channelId, channel.id), eq(follows.followerId, userId)))
        .limit(1),
      this.db
        .select({ tier: subscriptions.tier })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.channelId, channel.id),
            eq(subscriptions.subscriberId, userId),
            inArray(subscriptions.status, [...SUB_ACTIVE]),
          ),
        )
        .orderBy(desc(subscriptions.tier))
        .limit(1),
      this.db
        .select({ expiresAt: chatBans.expiresAt, reason: chatBans.reason })
        .from(chatBans)
        .where(and(eq(chatBans.channelId, channel.id), eq(chatBans.userId, userId), isNull(chatBans.liftedAt)))
        .limit(1),
    ]);
    const has = (r: string) => roles.some((x) => x.role === r);
    return {
      isBroadcaster: channel.ownerId === userId,
      isModerator: has("moderator"),
      isVip: has("vip"),
      followedAt: follow[0]?.createdAt ?? null,
      subscriberTier: sub[0]?.tier ?? null,
      ban: ban[0] ? { expiresAt: ban[0].expiresAt, reason: ban[0].reason } : null,
    };
  }
}
