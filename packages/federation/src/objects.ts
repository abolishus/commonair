// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ActivityStreams objects (ADR 0030 decision 3): the go-live `Note` and the `Video` for a public
 * VOD or clip, with stable ids from `federation_objects`, no media URL and no personal data
 * (decision 9). Pure; plain JSON with a fixed shape, no JSON-LD processing.
 *
 * - A `Note` carries the title, the category, a link to the channel page and the current thumbnail
 *   as an attachment.
 * - A `Video` carries the title, the duration, the thumbnail and a `url` to the watch page on the
 *   home instance. Never a playlist, segment or stream URL, and never the clipper (decision 3:
 *   local users do not federate).
 * - A mature channel or broadcast sends no thumbnail, `sensitive: true` and a content warning
 *   (`summary`) from the small server-side catalog below (decision 7).
 *
 * Text is the streamer's own (title, category name, channel name) or comes from `FEDERATION_TEXT`.
 * Remote servers render `content` as HTML, so every streamer string is escaped.
 */
import { AS2_PUBLIC } from "./activities.ts";

/** Object kinds stored in `federation_objects.kind`. */
export const FEDERATION_OBJECT_KINDS = ["note", "video"] as const;
export type FederationObjectKind = (typeof FEDERATION_OBJECT_KINDS)[number];

/** The ActivityPub paths this instance serves (the API's raw routes; Caddy proxies `/ap/*`). */
export const FEDERATION_PATHS = {
  actor: (channelId: string) => `/ap/channels/${channelId}`,
  sharedInbox: "/ap/inbox",
  object: (objectId: string) => `/ap/objects/${objectId}`,
} as const;

/** Every URL of one channel actor, from the instance's public origin (`instanceSite().publicUrl`). */
export interface ActorUrls {
  id: string;
  keyId: string;
  inbox: string;
  outbox: string;
  followers: string;
  sharedInbox: string;
}

const trimOrigin = (publicUrl: string) => publicUrl.replace(/\/+$/, "");

export function actorUrls(publicUrl: string, channelId: string): ActorUrls {
  const origin = trimOrigin(publicUrl);
  const id = `${origin}${FEDERATION_PATHS.actor(channelId)}`;
  return {
    id,
    keyId: `${id}#main-key`,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    sharedInbox: `${origin}${FEDERATION_PATHS.sharedInbox}`,
  };
}

/** The stable id of a `federation_objects` row. */
export const objectUrl = (publicUrl: string, objectId: string): string =>
  `${trimOrigin(publicUrl)}${FEDERATION_PATHS.object(objectId)}`;

/** Home pages the objects link to (the web's routes: `/$channel`, `/$channel/vods/$id`, `/$channel/clips/$id`). */
export const channelPageUrl = (publicUrl: string, slug: string) =>
  `${trimOrigin(publicUrl)}/${encodeURIComponent(slug)}`;
export const vodPageUrl = (publicUrl: string, slug: string, vodId: string) =>
  `${channelPageUrl(publicUrl, slug)}/vods/${vodId}`;
export const clipPageUrl = (publicUrl: string, slug: string, clipId: string) =>
  `${channelPageUrl(publicUrl, slug)}/clips/${clipId}`;

/**
 * The server-side text objects carry (like the worker's Discord table: channel content posted to
 * a third party, not the web catalog). `en` is the fallback; add a locale with every key.
 */
export const FEDERATION_TEXT = {
  en: {
    live: "{channel} is live",
    category: "Category: {category}",
    watch: "Watch on {channel}",
    mature: "Mature content (18+)",
    repliesNotRead: "Replies are not read. Watch and chat on the channel page.",
  },
  es: {
    live: "{channel} está en directo",
    category: "Categoría: {category}",
    watch: "Ver en {channel}",
    mature: "Contenido para adultos (18+)",
    repliesNotRead: "Las respuestas no se leen. Mira y chatea en la página del canal.",
  },
} as const;
export type FederationLocale = keyof typeof FEDERATION_TEXT;
export type FederationTextKey = keyof (typeof FEDERATION_TEXT)["en"];

/** The catalog for a locale tag (`es-MX` → `es`), English when there is none. */
export function federationText(locale: string): Record<FederationTextKey, string> {
  const base = locale.toLowerCase().split(/[-_]/)[0] ?? "en";
  return Object.hasOwn(FEDERATION_TEXT, base) ? FEDERATION_TEXT[base as FederationLocale] : FEDERATION_TEXT.en;
}

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

/** HTML-escape streamer text for `content` and `summary` (remote servers render them as HTML). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Media type of an image URL from its extension, when known (Mastodon infers it otherwise). */
export function imageMediaType(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".avif")) return "image/avif";
  return null;
}

/** An `Image` attachment (a thumbnail; never video, audio or a stream). */
export interface ImageAttachment {
  type: "Image";
  url: string;
  mediaType?: string;
  name: string;
}

function imageAttachment(url: string, name: string): ImageAttachment {
  const mediaType = imageMediaType(url);
  return { type: "Image", url, ...(mediaType ? { mediaType } : {}), name };
}

/** What every published object is addressed to: Public, and the followers collection in `cc`. */
export interface Addressed {
  to: [typeof AS2_PUBLIC];
  cc: [string];
}

export interface NoteObject extends Addressed {
  id: string;
  type: "Note";
  attributedTo: string;
  published: string;
  url: string;
  content: string;
  sensitive: boolean;
  summary?: string;
  attachment: ImageAttachment[];
}

export interface GoLiveNoteInput {
  /** The stable object id (`objectUrl`). */
  id: string;
  actor: Pick<ActorUrls, "id" | "followers">;
  channelName: string;
  /** The channel page (`channelPageUrl`). */
  channelUrl: string;
  title: string;
  category: string | null;
  /** The current public thumbnail, or null. Dropped for mature content. */
  thumbnailUrl: string | null;
  /** The channel's or the broadcast's mature label (or its category's). */
  mature: boolean;
  published: Date;
  locale: string;
}

/** The go-live `Note` (ADR 0030 decision 3). */
export function goLiveNote(input: GoLiveNoteInput): NoteObject {
  const text = federationText(input.locale);
  const channel = escapeHtml(input.channelName);
  const title = input.title.trim();
  const href = escapeHtml(input.channelUrl);
  const paragraphs = [
    `<p>${fill(text.live, { channel })}${title ? `: ${escapeHtml(title)}` : ""}</p>`,
    ...(input.category ? [`<p>${fill(text.category, { category: escapeHtml(input.category) })}</p>`] : []),
    `<p><a href="${href}">${href}</a></p>`,
  ];
  const thumb = !input.mature && input.thumbnailUrl ? input.thumbnailUrl : null;
  return {
    id: input.id,
    type: "Note",
    attributedTo: input.actor.id,
    published: input.published.toISOString(),
    url: input.channelUrl,
    to: [AS2_PUBLIC],
    cc: [input.actor.followers],
    content: paragraphs.join(""),
    sensitive: input.mature,
    ...(input.mature ? { summary: text.mature } : {}),
    attachment: thumb ? [imageAttachment(thumb, title || input.channelName)] : [],
  };
}

export interface VideoObject extends Addressed {
  id: string;
  type: "Video";
  attributedTo: string;
  published: string;
  name: string;
  /** ISO 8601 duration, whole seconds (`PT754S`). */
  duration: string;
  /** The watch page on the home instance, never a media URL. */
  url: [{ type: "Link"; mediaType: "text/html"; href: string }];
  content: string;
  sensitive: boolean;
  summary?: string;
  icon?: ImageAttachment;
  attachment: ImageAttachment[];
}

export interface MediaVideoInput {
  id: string;
  actor: Pick<ActorUrls, "id" | "followers">;
  channelName: string;
  title: string;
  durationSeconds: number;
  /** The watch page (`vodPageUrl` or `clipPageUrl`). */
  watchUrl: string;
  thumbnailUrl: string | null;
  mature: boolean;
  published: Date;
  locale: string;
}

/** ISO 8601 duration in whole seconds; negative or non-finite input is 0. */
export function isoDuration(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  return `PT${s}S`;
}

/**
 * The `Video` for a public VOD or clip. Attributed to the channel actor only: a clip's
 * `creatorId` is a local user and is never passed in (decision 3).
 */
export function mediaVideo(input: MediaVideoInput): VideoObject {
  const text = federationText(input.locale);
  const title = input.title.trim() || input.channelName;
  const href = escapeHtml(input.watchUrl);
  const thumb = !input.mature && input.thumbnailUrl ? imageAttachment(input.thumbnailUrl, title) : null;
  return {
    id: input.id,
    type: "Video",
    attributedTo: input.actor.id,
    published: input.published.toISOString(),
    name: title,
    duration: isoDuration(input.durationSeconds),
    url: [{ type: "Link", mediaType: "text/html", href: input.watchUrl }],
    to: [AS2_PUBLIC],
    cc: [input.actor.followers],
    content: `<p>${escapeHtml(title)}</p><p><a href="${href}">${fill(text.watch, { channel: escapeHtml(input.channelName) })}</a></p>`,
    sensitive: input.mature,
    ...(input.mature ? { summary: text.mature } : {}),
    ...(thumb ? { icon: thumb } : {}),
    attachment: thumb ? [thumb] : [],
  };
}

export interface TombstoneObject {
  id: string;
  type: "Tombstone";
  formerType: "Note" | "Video";
  deleted: string;
}

export function tombstone(id: string, kind: FederationObjectKind, deleted: Date): TombstoneObject {
  return { id, type: "Tombstone", formerType: kind === "note" ? "Note" : "Video", deleted: deleted.toISOString() };
}

/** The `publicKey` block of an actor document. */
export interface ActorPublicKey {
  id: string;
  owner: string;
  publicKeyPem: string;
}

export interface ServiceActor {
  "@context": [string, string];
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
  publicKey: ActorPublicKey;
  icon?: ImageAttachment;
  image?: ImageAttachment;
}

export interface ServiceActorInput {
  urls: ActorUrls;
  slug: string;
  displayName: string;
  description: string;
  channelUrl: string;
  publicKeyPem: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  mature: boolean;
  locale: string;
}

/**
 * The channel's `Service` actor document (decision 2), as `Update{Service}` carries it after a key
 * rotation. Mature channels send no avatar or banner (decision 7).
 */
export function serviceActor(input: ServiceActorInput, contexts: [string, string]): ServiceActor {
  const text = federationText(input.locale);
  const description = input.description.trim();
  return {
    "@context": contexts,
    id: input.urls.id,
    type: "Service",
    preferredUsername: input.slug,
    name: input.displayName,
    summary: `${description ? `<p>${escapeHtml(description)}</p>` : ""}<p>${escapeHtml(text.repliesNotRead)}</p>`,
    url: input.channelUrl,
    inbox: input.urls.inbox,
    outbox: input.urls.outbox,
    followers: input.urls.followers,
    endpoints: { sharedInbox: input.urls.sharedInbox },
    manuallyApprovesFollowers: false,
    publicKey: { id: input.urls.keyId, owner: input.urls.id, publicKeyPem: input.publicKeyPem },
    ...(!input.mature && input.avatarUrl ? { icon: imageAttachment(input.avatarUrl, input.displayName) } : {}),
    ...(!input.mature && input.bannerUrl ? { image: imageAttachment(input.bannerUrl, input.displayName) } : {}),
  };
}
