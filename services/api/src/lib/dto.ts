// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Row → DTO mapping shared by route files. DTOs (not rows) are what the API returns. */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { ChannelTheme } from "@commonair/contracts/shapes";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { viewerCount, viewerCounts } from "./viewers.ts";

const { users, channels, categories, broadcasts, channelPanels, channelSubTiers } = schema;
type UserRow = typeof users.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;
type BroadcastRow = typeof broadcasts.$inferSelect;
type CategoryRow = typeof categories.$inferSelect;

export type UserPublic = z.infer<typeof dto.UserPublic>;
export type BroadcastSummary = z.infer<typeof dto.BroadcastSummary>;
export type StreamCard = z.infer<typeof dto.StreamCard>;

export const iso = (d: Date) => d.toISOString();
export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Public URL for an object in the media bucket; absolute URLs (e.g. OAuth avatars) pass through. */
export function mediaUrl(deps: Deps, key: string | null | undefined): string | null {
  if (!key) return null;
  if (/^https?:\/\//.test(key)) return key;
  const base = (deps.env.S3_PUBLIC_ENDPOINT ?? deps.env.S3_ENDPOINT).replace(/\/+$/, "");
  return `${base}/${deps.env.S3_BUCKET_MEDIA}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function toUserPublic(deps: Deps, u: UserRow, botOwner: { id: string; username: string } | null): UserPublic {
  return {
    id: u.id,
    username: u.username,
    displayName: u.name,
    avatarUrl: mediaUrl(deps, u.image),
    accountType: u.accountType,
    botOwner: u.accountType === "bot" ? botOwner : null,
    createdAt: iso(u.createdAt),
  };
}

/** Load users by id as UserPublic, resolving bot owners in one extra query. */
export async function loadUsersPublic(deps: Deps, ids: readonly string[]): Promise<Map<string, UserPublic>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await deps.db.select().from(users).where(inArray(users.id, unique));
  const ownerIds = [...new Set(rows.map((r) => r.botOwnerId).filter((x): x is string => x !== null))];
  const owners = ownerIds.length
    ? await deps.db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ownerIds))
    : [];
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  return new Map(
    rows.map((r) => [r.id, toUserPublic(deps, r, r.botOwnerId ? (ownerById.get(r.botOwnerId) ?? null) : null)]),
  );
}

export async function loadUserPublic(deps: Deps, id: string): Promise<UserPublic | null> {
  return (await loadUsersPublic(deps, [id])).get(id) ?? null;
}

export const categoryRef = (c: Pick<CategoryRow, "id" | "slug" | "name"> | null) =>
  c ? { id: c.id, slug: c.slug, name: c.name } : null;

export function toBroadcastSummary(
  deps: Deps,
  b: BroadcastRow,
  category: Pick<CategoryRow, "id" | "slug" | "name"> | null,
  viewers: number,
): BroadcastSummary {
  return {
    id: b.id,
    title: b.title,
    category: categoryRef(category),
    startedAt: iso(b.startedAt),
    mature: b.mature,
    viewerCount: viewers,
    thumbnailUrl: mediaUrl(deps, b.thumbnailKey),
  };
}

export const channelTheme = (c: ChannelRow) => {
  const parsed = ChannelTheme.safeParse(c.theme);
  return parsed.success ? parsed.data : {};
};

/** Avatar: the channel theme's avatar, else the owner's profile image. */
export const channelAvatar = (deps: Deps, c: ChannelRow, ownerImage: string | null) =>
  mediaUrl(deps, channelTheme(c).avatarKey ?? ownerImage);

/** The live broadcast summary for a channel, or null when offline. */
export async function liveSummary(deps: Deps, c: ChannelRow): Promise<BroadcastSummary | null> {
  if (!c.liveBroadcastId) return null;
  const [row] = await deps.db
    .select({ b: broadcasts, cat: categories })
    .from(broadcasts)
    .leftJoin(categories, eq(categories.id, broadcasts.categoryId))
    .where(eq(broadcasts.id, c.liveBroadcastId))
    .limit(1);
  if (!row || row.b.endedAt) return null;
  return toBroadcastSummary(deps, row.b, row.cat, await viewerCount(deps, c.id));
}

/** Live summaries for many channels at once (directory, follows, search). */
export async function liveSummaries(deps: Deps, chans: readonly ChannelRow[]): Promise<Map<string, BroadcastSummary>> {
  const live = chans.filter((c) => c.liveBroadcastId);
  const out = new Map<string, BroadcastSummary>();
  if (live.length === 0) return out;
  const rows = await deps.db
    .select({ b: broadcasts, cat: categories })
    .from(broadcasts)
    .leftJoin(categories, eq(categories.id, broadcasts.categoryId))
    .where(
      inArray(
        broadcasts.id,
        live.map((c) => c.liveBroadcastId as string),
      ),
    );
  const counts = await viewerCounts(
    deps,
    live.map((c) => c.id),
  );
  for (const r of rows)
    if (!r.b.endedAt) out.set(r.b.channelId, toBroadcastSummary(deps, r.b, r.cat, counts.get(r.b.channelId) ?? 0));
  return out;
}

export async function toChannelDto(deps: Deps, c: ChannelRow): Promise<z.infer<typeof dto.Channel>> {
  const [owner, category, panels, tiers, live] = await Promise.all([
    loadUserPublic(deps, c.ownerId),
    c.categoryId
      ? deps.db
          .select({ id: categories.id, slug: categories.slug, name: categories.name })
          .from(categories)
          .where(eq(categories.id, c.categoryId))
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    deps.db.select().from(channelPanels).where(eq(channelPanels.channelId, c.id)).orderBy(asc(channelPanels.position)),
    deps.db
      .select()
      .from(channelSubTiers)
      .where(eq(channelSubTiers.channelId, c.id))
      .orderBy(asc(channelSubTiers.tier)),
    liveSummary(deps, c),
  ]);
  if (!owner) throw new Error(`channel ${c.id} has no owner row`);
  const theme = channelTheme(c);
  const currency = deps.env.CURRENCY;
  return {
    id: c.id,
    slug: c.slug,
    displayName: c.displayName,
    title: c.title,
    description: c.description,
    category,
    tags: c.tags,
    language: c.language,
    mature: c.mature,
    theme,
    avatarUrl: mediaUrl(deps, theme.avatarKey) ?? owner.avatarUrl,
    bannerUrl: mediaUrl(deps, theme.bannerKey),
    owner,
    followerCount: c.followerCount,
    live,
    panels: panels.map(toPanelDto(deps)),
    vodEnabled: c.vodEnabled,
    subTiers: tiers.map((t) => ({
      tier: t.tier,
      name: t.name,
      price: { cents: t.priceCents, currency },
      benefits: t.benefits,
    })),
    suspended: c.suspendedAt !== null,
  };
}

export const toPanelDto = (deps: Deps) => (p: typeof channelPanels.$inferSelect) => ({
  id: p.id,
  position: p.position,
  title: p.title,
  body: p.body,
  imageUrl: mediaUrl(deps, p.imageKey),
  linkUrl: p.linkUrl,
});

export async function channelBySlug(deps: Deps, slug: string): Promise<ChannelRow | null> {
  const [c] = await deps.db.select().from(channels).where(eq(channels.slug, slug)).limit(1);
  return c ?? null;
}

export async function userByUsername(deps: Deps, username: string): Promise<UserRow | null> {
  const [u] = await deps.db
    .select()
    .from(users)
    .where(and(eq(users.username, username.toLowerCase())))
    .limit(1);
  return u && !u.deletedAt ? u : null;
}
