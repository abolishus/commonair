// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WebFinger (RFC 7033) for channel actors (ADR 0030 decision 2): `acct:<slug>@<domain>`, or the
 * actor id itself, resolves to a JRD whose `self` link is the actor. Anything else (another
 * domain, an unknown, unfederated or suspended channel) is 404.
 */
import type { InstanceSite } from "@commonair/config/site";
import type { Deps } from "../deps.ts";
import {
  ACTIVITY_JSON,
  actorUrl,
  channelPageUrl,
  federatedChannel,
  federatedChannelIdBySlug,
  instanceHost,
} from "./ids.ts";

export const JRD_JSON = "application/jrd+json";
const SLUG = /^[a-z0-9_]{3,25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A resource longer than this is not one of ours. */
const MAX_RESOURCE = 512;

export type WebfingerResource = { kind: "slug"; slug: string } | { kind: "actor"; channelId: string };

/**
 * Parse `resource` for this instance. Accepts `acct:slug@host`, `acct:@slug@host` and a bare
 * `slug@host` (some clients drop the scheme), case-insensitively, and the actor id URL. The host
 * must be this instance's (`host[:port]`); anything else is null.
 */
export function parseWebfingerResource(
  resource: string | null,
  site: Pick<InstanceSite, "publicUrl">,
): WebfingerResource | null {
  if (!resource || resource.length > MAX_RESOURCE) return null;
  const host = instanceHost(site);
  const raw = resource.trim();
  if (/^https?:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (u.origin !== new URL(site.publicUrl).origin || u.search || u.hash) return null;
    const m = /^\/ap\/channels\/([^/]+)$/.exec(u.pathname);
    const id = m?.[1]?.toLowerCase();
    return id && UUID.test(id) ? { kind: "actor", channelId: id } : null;
  }
  const acct = raw.replace(/^acct:/i, "").replace(/^@/, "");
  const at = acct.lastIndexOf("@");
  if (at <= 0) return null;
  const slug = acct.slice(0, at).toLowerCase();
  const domain = acct
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "");
  if (domain !== host || !SLUG.test(slug)) return null;
  return { kind: "slug", slug };
}

export interface Jrd {
  subject: string;
  aliases: string[];
  links: { rel: string; type: string; href: string }[];
}

export function buildJrd(site: Pick<InstanceSite, "publicUrl">, slug: string, channelId: string): Jrd {
  const actor = actorUrl(site, channelId);
  const page = channelPageUrl(site, slug);
  return {
    subject: `acct:${slug}@${instanceHost(site)}`,
    aliases: [actor, page],
    links: [
      { rel: "self", type: ACTIVITY_JSON, href: actor },
      { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: page },
    ],
  };
}

/** The JRD for `resource`, or null (404). */
export async function webfinger(deps: Pick<Deps, "db" | "site" | "now">, resource: string | null): Promise<Jrd | null> {
  const parsed = parseWebfingerResource(resource, deps.site);
  if (!parsed) return null;
  const channelId = parsed.kind === "slug" ? await federatedChannelIdBySlug(deps, parsed.slug) : parsed.channelId;
  if (!channelId) return null;
  const found = await federatedChannel(deps, channelId);
  if (found.state !== "ok") return null;
  return buildJrd(deps.site, found.channel.slug, found.channel.id);
}
