// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel actor document (ADR 0030 decision 2): a `Service`, because its posts are automated,
 * with the AS2 and security contexts as plain JSON (no JSON-LD processing). It carries only what
 * the public channel page shows (decision 9). Mature channels publish no avatar or banner: remote
 * servers are outside the 18+ gate (decision 7).
 */
import { AS2_CONTEXT, SECURITY_CONTEXT } from "@commonair/federation";
import type { InstanceSite } from "@commonair/config/site";
import type { Deps } from "../deps.ts";
import { channelTheme, mediaUrl } from "../lib/dto.ts";
import { actorUrl, channelPageUrl, followersUrl, inboxUrl, keyIdOf, outboxUrl, sharedInboxUrl } from "./ids.ts";
import { federationMessage } from "./messages.ts";

export interface ActorInput {
  channelId: string;
  slug: string;
  displayName: string;
  description: string;
  mature: boolean;
  avatarUrl: string | null;
  bannerUrl: string | null;
  publicKeyPem: string;
  publishedAt: Date;
}

export interface ActorImage {
  type: "Image";
  url: string;
}

export interface ActorDocument {
  "@context": string[];
  id: string;
  type: "Service";
  preferredUsername: string;
  name: string;
  summary: string;
  url: string;
  inbox: string;
  outbox: string;
  followers: string;
  endpoints: { sharedInbox: string };
  manuallyApprovesFollowers: false;
  published: string;
  icon?: ActorImage;
  image?: ActorImage;
  publicKey: { id: string; owner: string; publicKeyPem: string };
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

/**
 * `summary` is HTML on Mastodon: the streamer's description (escaped, one paragraph per blank-line
 * block, line breaks kept), then the catalog's "replies are not read" line.
 */
export function actorSummary(description: string, notice: string): string {
  const paragraphs = description
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  return [...paragraphs, `<p>${escapeHtml(notice)}</p>`].join("");
}

export function buildActorDocument(
  site: Pick<InstanceSite, "publicUrl" | "name" | "defaultLocale">,
  a: ActorInput,
): ActorDocument {
  const id = actorUrl(site, a.channelId);
  const notice = federationMessage(site.defaultLocale, "repliesNotRead", { instance: site.name });
  const doc: ActorDocument = {
    "@context": [AS2_CONTEXT, SECURITY_CONTEXT],
    id,
    type: "Service",
    preferredUsername: a.slug,
    name: a.displayName,
    summary: actorSummary(a.description, notice),
    url: channelPageUrl(site, a.slug),
    inbox: inboxUrl(id),
    outbox: outboxUrl(id),
    followers: followersUrl(id),
    endpoints: { sharedInbox: sharedInboxUrl(site) },
    manuallyApprovesFollowers: false,
    published: a.publishedAt.toISOString(),
    publicKey: { id: keyIdOf(id), owner: id, publicKeyPem: a.publicKeyPem },
  };
  if (!a.mature) {
    if (a.avatarUrl) doc.icon = { type: "Image", url: a.avatarUrl };
    if (a.bannerUrl) doc.image = { type: "Image", url: a.bannerUrl };
  }
  return doc;
}

/** The input for a federated channel's row (`federatedChannel` state "ok"). */
export function actorInputOf(
  deps: Pick<Deps, "env">,
  found: {
    channel: {
      id: string;
      slug: string;
      displayName: string;
      description: string;
      mature: boolean;
      theme: unknown;
      createdAt: Date;
    };
    actor: { publicKeyPem: string };
    ownerImage: string | null;
  },
): ActorInput {
  const theme = channelTheme(found.channel as Parameters<typeof channelTheme>[0]);
  return {
    channelId: found.channel.id,
    slug: found.channel.slug,
    displayName: found.channel.displayName,
    description: found.channel.description,
    mature: found.channel.mature,
    avatarUrl: mediaUrl(deps, theme.avatarKey ?? found.ownerImage),
    bannerUrl: mediaUrl(deps, theme.bannerKey),
    publicKeyPem: found.actor.publicKeyPem,
    publishedAt: found.channel.createdAt,
  };
}

/**
 * Whether the client asked for the ActivityPub document rather than the page: an `Accept` naming
 * `application/activity+json` or `application/ld+json` (any profile). No `Accept`, or one that
 * names neither HTML nor AP, gets the document too (servers are the main callers); an `Accept`
 * that names HTML and not AP is a browser, redirected to the channel page.
 */
export function wantsActivityJson(accept: string | null): boolean {
  if (!accept) return true;
  const types = accept
    .toLowerCase()
    .split(",")
    .map((part) => {
      const [type = "", ...params] = part.split(";").map((s) => s.trim());
      const q = params.find((p) => p.startsWith("q="));
      return { type, q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((t) => t.q > 0);
  if (types.some((t) => t.type === "application/activity+json" || t.type === "application/ld+json")) return true;
  return !types.some((t) => t.type === "text/html" || t.type === "application/xhtml+xml");
}
