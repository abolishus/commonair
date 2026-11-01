// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ActivityPub identifiers and the channel lookup every federation document shares (ADR 0030
 * decision 2). The domain comes from `instanceSite()` (`deps.site.publicUrl`, AGENTS.md rule 5);
 * actor ids are built from the channel id, so a slug change never orphans followers.
 */
import type { InstanceSite } from "@commonair/config/site";
import { schema } from "@commonair/db";
import { and, eq, sql } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { actorPath, SHARED_INBOX_PATH } from "../raw-routes.ts";

const { channels, federationActors, users } = schema;

/** Media type of ActivityPub answers (Mastodon sends and expects this one). */
export const ACTIVITY_JSON = "application/activity+json";
export const ACTIVITY_JSON_UTF8 = `${ACTIVITY_JSON}; charset=utf-8`;

/** `host[:port]` of this instance, lower-cased: the `@domain` of every handle. */
export const instanceHost = (site: Pick<InstanceSite, "publicUrl">) => new URL(site.publicUrl).host.toLowerCase();

export const actorUrl = (site: Pick<InstanceSite, "publicUrl">, channelId: string) =>
  `${site.publicUrl}${actorPath(channelId)}`;
export const keyIdOf = (actor: string) => `${actor}#main-key`;
export const inboxUrl = (actor: string) => `${actor}/inbox`;
export const outboxUrl = (actor: string) => `${actor}/outbox`;
export const followersUrl = (actor: string) => `${actor}/followers`;
export const sharedInboxUrl = (site: Pick<InstanceSite, "publicUrl">) => `${site.publicUrl}${SHARED_INBOX_PATH}`;
/** The channel page on the web app. */
export const channelPageUrl = (site: Pick<InstanceSite, "publicUrl">, slug: string) =>
  `${site.publicUrl}/${encodeURIComponent(slug)}`;
/**
 * The stable id of a `federation_objects` row, and of the `Create` that published it. N4-delivery
 * builds the same ids when it sends the object (contract request: move both into
 * `packages/federation/src/objects.ts`).
 */
export const objectUrl = (site: Pick<InstanceSite, "publicUrl">, objectId: string) =>
  `${site.publicUrl}/ap/objects/${objectId}`;
export const createActivityUrl = (site: Pick<InstanceSite, "publicUrl">, objectId: string) =>
  `${objectUrl(site, objectId)}/activity`;
export const handleOf = (site: Pick<InstanceSite, "publicUrl">, slug: string) => `@${slug}@${instanceHost(site)}`;

/**
 * A hostname for comparison: lower-case, no port, no trailing dot. URL parsing turns IDNs into
 * punycode, so a block on `xn--…` matches the Unicode spelling too. Null when it is not a URL.
 */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    return h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

type ChannelRow = typeof channels.$inferSelect;
type ActorRow = typeof federationActors.$inferSelect;

export type FederatedChannel =
  | { state: "ok"; channel: ChannelRow; actor: ActorRow; ownerImage: string | null }
  /** Federated once (an actor row exists), now off or suspended: its actor `Delete` went out. */
  | { state: "gone" }
  /** Unknown, or never federated. */
  | { state: "missing" };

/**
 * The channel suspended for federation: the channel itself, or its owner's account while that
 * ban is in force (the same rule as `channel.suspension`, `events/media-state.ts`).
 */
export const suspendedSql = (now: Date) =>
  sql<boolean>`(${channels.suspendedAt} is not null or (${users.banned} and (${users.banExpires} is null or ${users.banExpires} > ${now.toISOString()}::timestamptz)))`;

/**
 * Look a channel up for the public documents. "missing" (404) when it does not exist or never
 * federated; "gone" (410) when it federated once but is now off or suspended (ADR 0030: the
 * worker then sent `Delete` of the actor, and remote servers treat 410 as that deletion).
 */
export async function federatedChannel(deps: Pick<Deps, "db" | "now">, channelId: string): Promise<FederatedChannel> {
  const [row] = await deps.db
    .select({
      channel: channels,
      actor: federationActors,
      ownerImage: users.image,
      suspended: suspendedSql(deps.now()),
    })
    .from(channels)
    .innerJoin(users, eq(users.id, channels.ownerId))
    .leftJoin(federationActors, eq(federationActors.channelId, channels.id))
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!row?.actor) return { state: "missing" };
  if (row.suspended || !row.actor.enabled || !row.channel.federationSettings.enabled) return { state: "gone" };
  return { state: "ok", channel: row.channel, actor: row.actor, ownerImage: row.ownerImage };
}

/** The channel id behind a slug, when that channel is federated now (WebFinger). */
export async function federatedChannelIdBySlug(deps: Pick<Deps, "db">, slug: string): Promise<string | null> {
  const [row] = await deps.db
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(federationActors, and(eq(federationActors.channelId, channels.id), eq(federationActors.enabled, true)))
    .where(eq(channels.slug, slug))
    .limit(1);
  return row?.id ?? null;
}
