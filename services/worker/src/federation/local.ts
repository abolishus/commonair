// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * This instance's side (ADR 0030 decisions 2, 4 and 7): a channel's actor, its signing key
 * (decrypted at use, never logged), whether it federates now, its follower inboxes, and the
 * domain block list.
 */
import { ChannelFederationSettings } from "@commonair/contracts/shapes";
import { type Executor, schema as s } from "@commonair/db";
import {
  actorUrls,
  type ActorUrls,
  importPrivateKeyPem,
  type ServiceActorInput,
  channelPageUrl,
} from "@commonair/federation";
import { decryptSecret } from "@commonair/tokens";
import { eq } from "drizzle-orm";
import { FEDERATION_KEY_PURPOSE, type FederationConfig, mediaUrl } from "./config.ts";

export interface LocalChannel {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  mature: boolean;
  suspended: boolean;
  /** The streamer's `federation.enabled`. */
  settingEnabled: boolean;
  avatarKey: string | null;
  urls: ActorUrls;
  /** The actor row, when federation was ever turned on. */
  actor: { enabled: boolean; keyId: string; publicKeyPem: string; privateKeyEnc: string; keyCreatedAt: Date } | null;
}

export async function loadChannel(
  db: Executor,
  cfg: Pick<FederationConfig, "site">,
  channelId: string,
): Promise<LocalChannel | null> {
  const [row] = await db
    .select({
      id: s.channels.id,
      slug: s.channels.slug,
      displayName: s.channels.displayName,
      description: s.channels.description,
      mature: s.channels.mature,
      suspendedAt: s.channels.suspendedAt,
      settings: s.channels.federationSettings,
      avatarKey: s.users.image,
      actorEnabled: s.federationActors.enabled,
      keyId: s.federationActors.keyId,
      publicKeyPem: s.federationActors.publicKeyPem,
      privateKeyEnc: s.federationActors.privateKeyEnc,
      keyCreatedAt: s.federationActors.keyCreatedAt,
    })
    .from(s.channels)
    .innerJoin(s.users, eq(s.users.id, s.channels.ownerId))
    .leftJoin(s.federationActors, eq(s.federationActors.channelId, s.channels.id))
    .where(eq(s.channels.id, channelId));
  if (!row) return null;
  const settings = ChannelFederationSettings.safeParse(row.settings ?? {});
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    mature: row.mature,
    suspended: row.suspendedAt !== null,
    settingEnabled: settings.success && settings.data.enabled,
    avatarKey: row.avatarKey,
    urls: actorUrls(cfg.site.publicUrl, row.id),
    actor:
      row.keyId !== null && row.publicKeyPem !== null && row.privateKeyEnc !== null && row.keyCreatedAt !== null
        ? {
            enabled: row.actorEnabled ?? false,
            keyId: row.keyId,
            publicKeyPem: row.publicKeyPem,
            privateKeyEnc: row.privateKeyEnc,
            keyCreatedAt: row.keyCreatedAt,
          }
        : null,
  };
}

/** Whether the channel publishes now: instance flag, the streamer's setting, an enabled actor, not suspended. */
export const federates = (
  cfg: Pick<FederationConfig, "enabled">,
  ch: LocalChannel | null,
): ch is LocalChannel & { actor: NonNullable<LocalChannel["actor"]> } =>
  cfg.enabled && ch !== null && ch.settingEnabled && ch.actor !== null && ch.actor.enabled && !ch.suspended;

/** The channel id an actor id of this instance names, or null. */
export function localChannelIdOf(cfg: Pick<FederationConfig, "site">, actorId: string): string | null {
  const prefix = actorUrls(cfg.site.publicUrl, "").id;
  if (!actorId.startsWith(prefix)) return null;
  const id = actorId.slice(prefix.length).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
}

/** Decrypt and import a stored private key for signing (non-extractable). Never log the PEM. */
export async function signingKey(cfg: Pick<FederationConfig, "authSecret">, privateKeyEnc: string): Promise<CryptoKey> {
  return importPrivateKeyPem(await decryptSecret(cfg.authSecret, FEDERATION_KEY_PURPOSE, privateKeyEnc));
}

/** What `Update{Service}` needs to rebuild the actor document. */
export function serviceActorInput(cfg: FederationConfig, ch: LocalChannel, publicKeyPem: string): ServiceActorInput {
  return {
    urls: ch.urls,
    slug: ch.slug,
    displayName: ch.displayName,
    description: ch.description,
    channelUrl: channelPageUrl(cfg.site.publicUrl, ch.slug),
    publicKeyPem,
    avatarUrl: mediaUrl(cfg, ch.avatarKey),
    bannerUrl: null,
    mature: ch.mature,
    locale: cfg.site.defaultLocale,
  };
}

// ------------------------------------------------------------ domain blocks

/** Whether `host` is `domain` or one of its subdomains (case-insensitive; ports ignored). */
export function domainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const d = domain.toLowerCase().replace(/\.$/, "");
  return h === d || h.endsWith(`.${d}`);
}

export async function blockedDomains(db: Executor): Promise<string[]> {
  const rows = await db.select({ domain: s.federationDomainBlocks.domain }).from(s.federationDomainBlocks);
  return rows.map((r) => r.domain);
}

/** Whether any of the URLs' hosts is blocked. Unparseable URLs count as blocked. */
export function isBlocked(blocks: readonly string[], ...urls: string[]): boolean {
  for (const u of urls) {
    let host: string;
    try {
      host = new URL(u).hostname;
    } catch {
      return true;
    }
    if (blocks.some((d) => domainMatches(host, d))) return true;
  }
  return false;
}

/**
 * The distinct inboxes a channel's followers are reached at: the shared inbox where the remote
 * server offers one, else the follower's own (decision 8). Blocked domains are left out.
 */
export async function followerInboxes(db: Executor, channelId: string): Promise<string[]> {
  const [rows, blocks] = await Promise.all([
    db
      .select({ inbox: s.federationFollowers.inbox, sharedInbox: s.federationFollowers.sharedInbox })
      .from(s.federationFollowers)
      .where(eq(s.federationFollowers.channelId, channelId)),
    blockedDomains(db),
  ]);
  const out = new Set<string>();
  for (const r of rows) {
    const target = r.sharedInbox ?? r.inbox;
    if (!isBlocked(blocks, target)) out.add(target);
  }
  return [...out].sort();
}
