// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * From Helix data to the portability bundle (ADR 0031 decision 3, batch 7 decision (j)).
 *
 * - `snapshotOf` keeps the public fields the preview stores (`portability_imports.preview`): no
 *   token, no email, nothing Helix did not answer publicly.
 * - `toBundle` maps a snapshot into a `PortabilityBundle` v1 (`source: "twitch"`, `standing: null`):
 *   tags and language through the studio's rules; any content classification label suggests
 *   `mature: true` (an import never clears one); the category by name; subscriber tiers
 *   1000/2000/3000 to 1–3 and follower emotes to 0; Bits and other emote types are skipped and
 *   listed; the schedule is carried, never applied. Panels come in by paste (`panelPaste`).
 * - `previewItems` lists what the preview shows, with the reasons an item cannot be imported.
 */
import type { ImportItemKind, ImportItemOutcome } from "@commonair/contracts/enums";
import {
  PORTABILITY_BUNDLE_VERSION,
  PORTABILITY_LIMITS,
  PortabilityBundle,
  type BundleEmote,
} from "@commonair/contracts/portability";
import { z } from "zod";
import type { HelixChannel, HelixEmote, HelixEmotesResponse, HelixScheduleSegment, HelixUser } from "./helix.ts";

/** How long a preview may be started after the authorization (ADR 0031: the token is gone, the data ages). */
export const PREVIEW_TTL_MS = 60 * 60 * 1000;
/** The wording version of the emote-art assertion on the import page (`n3-import`). */
export const EMOTE_ASSERTION_VERSION = "n3-import.2026-11-01";

/** The studio's emote code rule (`chat.emotes.create`). */
export const EMOTE_CODE = /^[A-Za-z0-9]{2,20}$/;
const TAG = /^[\p{L}\p{N}-]+$/u;
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/;

/** Why a Twitch emote is not offered. */
export const EMOTE_SKIP_REASONS = [
  "bits_emote",
  "unsupported_emote_type",
  "invalid_code",
  "duplicate_code",
  "emote_limit",
  "code_taken",
] as const;
export type EmoteSkipReason = (typeof EMOTE_SKIP_REASONS)[number];

/** The stored preview: public Helix data only. */
export const TwitchSnapshot = z.object({
  user: z.object({
    id: z.string().max(64),
    login: z.string().max(64),
    displayName: z.string().max(64),
    description: z.string().max(2000),
  }),
  channel: z.object({
    title: z.string().max(500),
    gameName: z.string().max(200),
    tags: z.array(z.string().max(100)).max(50),
    language: z.string().max(16),
    classificationLabels: z.array(z.string().max(100)).max(50),
  }),
  emotes: z
    .array(
      z.object({
        id: z.string().max(100),
        name: z.string().max(100),
        tier: z.string().max(10),
        type: z.string().max(40),
        animated: z.boolean(),
        /** The image to fetch at import (only from `TWITCH_IMAGE_HOSTS`). */
        imageUrl: z.string().max(2000).nullable(),
      }),
    )
    .max(1000),
  schedule: z
    .array(
      z.object({
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }).nullable(),
        title: z.string().max(500),
        category: z.string().max(200).nullable(),
      }),
    )
    .max(PORTABILITY_LIMITS.maxScheduleEntries),
});
export type TwitchSnapshot = z.infer<typeof TwitchSnapshot>;

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? "");

/** The best image of an emote: the animated template for animated ones, else the largest static image. */
export function emoteImageUrl(e: HelixEmote, template: string | undefined): string | null {
  const animated = e.format.includes("animated");
  if (animated && template) return fill(template, { id: e.id, format: "animated", theme_mode: "dark", scale: "3.0" });
  return e.images.url_4x ?? e.images.url_2x ?? e.images.url_1x ?? null;
}

export function snapshotOf(input: {
  user: HelixUser;
  channel: HelixChannel;
  emotes: HelixEmotesResponse;
  schedule: readonly HelixScheduleSegment[];
}): TwitchSnapshot {
  return {
    user: {
      id: input.user.id,
      login: input.user.login,
      displayName: input.user.display_name,
      description: input.user.description,
    },
    channel: {
      title: input.channel.title,
      gameName: input.channel.game_name,
      tags: input.channel.tags ?? [],
      language: input.channel.broadcaster_language,
      classificationLabels: input.channel.content_classification_labels ?? [],
    },
    emotes: input.emotes.data.map((e) => ({
      id: e.id,
      name: e.name,
      tier: e.tier,
      type: e.emote_type,
      animated: e.format.includes("animated"),
      imageUrl: emoteImageUrl(e, input.emotes.template),
    })),
    schedule: input.schedule.slice(0, PORTABILITY_LIMITS.maxScheduleEntries).map((s) => ({
      startsAt: s.start_time,
      endsAt: s.end_time ?? null,
      title: s.title,
      category: s.category?.name ?? null,
    })),
  };
}

// Field rules ---------------------------------------------------------------------------------

/** Tags as the studio stores them: valid ones, lower-cased, de-duplicated, at most 10. */
export function mapTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    if (t.length < 1 || t.length > 25 || !TAG.test(t)) continue;
    out.add(t.toLowerCase());
  }
  return [...out].slice(0, 10);
}

/** Twitch's broadcaster language as a studio code; `other` or anything malformed falls back. */
export function mapLanguage(language: string, fallback: string): string {
  const l = language.trim().toLowerCase();
  return LANGUAGE.test(l) ? l : fallback;
}

/** Any content classification label suggests the mature label (a suggestion; an import never clears one). */
export const matureSuggested = (labels: readonly string[]): boolean => labels.length > 0;

/** UTF-16 length cap without splitting a surrogate pair (the contracts count UTF-16 units). */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** Subscriber tiers 1000/2000/3000 → 1–3, follower emotes → 0; anything else is skipped. */
export function emoteTier(e: { type: string; tier: string }): { tier: number } | { skip: EmoteSkipReason } {
  if (e.type === "follower") return { tier: 0 };
  if (e.type === "bitstier") return { skip: "bits_emote" };
  if (e.type === "subscriptions") {
    const t = { "1000": 1, "2000": 2, "3000": 3 }[e.tier];
    return t === undefined ? { skip: "unsupported_emote_type" } : { tier: t };
  }
  return { skip: "unsupported_emote_type" };
}

/** A flat, safe archive name for an emote's image. */
export const emoteFile = (twitchId: string): string =>
  `files/emote-${twitchId
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.\.+/g, "_")
    .slice(0, 90)}`;

export interface EmotePlan {
  /** The Twitch emote id and name. */
  id: string;
  name: string;
  /** Null when the emote is not offered. */
  emote: BundleEmote | null;
  imageUrl: string | null;
  skip: EmoteSkipReason | null;
}

/** Every Twitch emote, in order, with its bundle entry or the reason it is skipped. */
export function planEmotes(snapshot: TwitchSnapshot, takenCodes: ReadonlySet<string> = new Set()): EmotePlan[] {
  const seen = new Set<string>();
  let offered = 0;
  return snapshot.emotes.map((e) => {
    const base = { id: e.id, name: e.name, imageUrl: e.imageUrl };
    const tier = emoteTier(e);
    if ("skip" in tier) return { ...base, emote: null, skip: tier.skip };
    if (!EMOTE_CODE.test(e.name) || !e.imageUrl) return { ...base, emote: null, skip: "invalid_code" as const };
    const key = e.name.toLowerCase();
    if (seen.has(key)) return { ...base, emote: null, skip: "duplicate_code" as const };
    seen.add(key);
    if (takenCodes.has(e.name)) return { ...base, emote: null, skip: "code_taken" as const };
    if (offered >= PORTABILITY_LIMITS.maxEmotes) return { ...base, emote: null, skip: "emote_limit" as const };
    offered++;
    return {
      ...base,
      emote: { code: e.name, tier: tier.tier, animated: e.animated, file: emoteFile(e.id) },
      skip: null,
    };
  });
}

export interface ToBundleOptions {
  /** This instance's host (`PUBLIC_URL`), the bundle's `instance.domain`. */
  domain: string;
  /** This build's version, for `instance.version`. */
  version?: string;
  exportedAt: Date;
  /** The channel's current language, when Twitch's is `other` or malformed. */
  fallbackLanguage: string;
  /** Codes the channel already has: those emotes are left out (and reported by `previewItems`). */
  takenCodes?: ReadonlySet<string>;
}

export interface ToBundleResult {
  bundle: PortabilityBundle;
  /** The emotes in the bundle, with the image each needs. */
  sources: { code: string; file: string; url: string }[];
  /** Twitch emotes left out, with why. */
  skipped: { ref: string; reason: EmoteSkipReason }[];
}

const DOMAIN = /^[a-z0-9.-]+(:[0-9]{1,5})?$/;

/** See the module comment. Throws only when the result would not be a valid bundle (a bug). */
export function toBundle(snapshot: TwitchSnapshot, opts: ToBundleOptions): ToBundleResult {
  const plans = planEmotes(snapshot, opts.takenCodes);
  const emotes = plans.flatMap((p) => (p.emote ? [p.emote] : []));
  const domain = opts.domain.toLowerCase();
  const bundle = PortabilityBundle.parse({
    v: PORTABILITY_BUNDLE_VERSION,
    source: "twitch",
    exportedAt: opts.exportedAt.toISOString(),
    instance: {
      domain: DOMAIN.test(domain) ? domain : "localhost",
      software: "commonair",
      version: capText(opts.version ?? "", 64),
    },
    channel: {
      title: capText(snapshot.channel.title.trim(), 140),
      description: capText(snapshot.user.description, 2000),
      tags: mapTags(snapshot.channel.tags),
      language: mapLanguage(snapshot.channel.language, mapLanguage(opts.fallbackLanguage, "en")),
      mature: matureSuggested(snapshot.channel.classificationLabels),
      categorySlug: null,
      categoryName: snapshot.channel.gameName ? capText(snapshot.channel.gameName, 200) : null,
    },
    panels: [],
    emotes,
    schedule: snapshot.schedule.map((s) => ({
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      title: capText(s.title, 140),
      category: s.category === null ? null : capText(s.category, 200),
    })),
    standing: null,
  });
  return {
    bundle,
    sources: plans.flatMap((p) =>
      p.emote && p.imageUrl ? [{ code: p.emote.code, file: p.emote.file, url: p.imageUrl }] : [],
    ),
    skipped: plans.flatMap((p) => (p.skip ? [{ ref: p.name, reason: p.skip }] : [])),
  };
}

export interface PreviewItem {
  kind: ImportItemKind;
  ref: string;
  label: string;
  outcome: ImportItemOutcome | null;
  reason: string | null;
}

/** What the preview offers: the channel fields, each Twitch emote (with a skip reason when not offered), the schedule. */
export function previewItems(snapshot: TwitchSnapshot, takenCodes: ReadonlySet<string> = new Set()): PreviewItem[] {
  const items: PreviewItem[] = [
    { kind: "channel", ref: "channel", label: capText(snapshot.channel.title, 140), outcome: null, reason: null },
  ];
  for (const p of planEmotes(snapshot, takenCodes))
    items.push({
      kind: "emote",
      ref: capText(p.name, 100),
      label: capText(p.name, 100),
      outcome: p.skip ? "skipped" : null,
      reason: p.skip,
    });
  if (snapshot.schedule.length > 0)
    items.push({
      kind: "schedule",
      ref: "schedule",
      label: String(snapshot.schedule.length),
      outcome: "skipped",
      reason: "carried_not_applied",
    });
  return items;
}
