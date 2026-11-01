// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pure rules `applyBundle` applies (ADR 0037 decision 5), kept apart so they are unit-tested
 * without a database: the same limits as a studio edit (`channels.update`, `channels.setPanels`,
 * `chat.emotes.create`), the mature rule and the category mapping.
 */
import type { BundleChannel, BundlePanel } from "@commonair/contracts/portability";

/** `chat.emotes.create`'s cap (services/api/src/routes/chat.ts `MAX_EMOTES`). */
export const MAX_EMOTES = 100;
/** `channels.setPanels`'s cap. */
export const MAX_PANELS = 20;
export const EMOTE_CODE = /^[A-Za-z0-9]{2,20}$/;
const TAG = /^[\p{L}\p{N}-]+$/u;
/** A stream key pasted into text is redacted before it is stored (the studio scrubs the same way). */
const STREAM_KEY = /live_[A-Za-z0-9_-]{43}/g;

export const redactStreamKeys = (text: string): string => text.replace(STREAM_KEY, "[redacted]");

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  mature: boolean;
}

/** Map by slug, then by exact name; otherwise null (the category stays as it is). */
export function mapCategory(
  categories: readonly CategoryRow[],
  slug: string | null,
  name: string | null,
): CategoryRow | null {
  if (slug) {
    const bySlug = categories.find((c) => c.slug === slug);
    if (bySlug) return bySlug;
  }
  if (name) {
    const byName = categories.find((c) => c.name === name);
    if (byName) return byName;
  }
  return null;
}

/**
 * The mature label after an import: an import never clears one; `mature: true` in the bundle sets
 * it; a mature category forces it, as a studio edit does.
 */
export const matureAfterImport = (current: boolean, bundleMature: boolean, categoryMature: boolean): boolean =>
  current || bundleMature || categoryMature;

/** Tags as `channels.update` stores them: valid ones only, lower-cased, de-duplicated, at most 10. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    if (t.length < 1 || t.length > 25 || !TAG.test(t)) continue;
    out.add(t.toLowerCase());
  }
  return [...out].slice(0, 10);
}

export interface ChannelPatch {
  title: string;
  description: string;
  tags: string[];
  language: string;
  mature: boolean;
  /** Undefined: leave the category as it is. */
  categoryId?: string;
}

/** The channel columns an import writes, through the studio edit's rules. */
export function channelPatch(
  current: { mature: boolean },
  bundle: BundleChannel,
  category: CategoryRow | null,
): ChannelPatch {
  return {
    title: redactStreamKeys(bundle.title.trim()).slice(0, 140),
    description: redactStreamKeys(bundle.description).slice(0, 2000),
    tags: normalizeTags(bundle.tags),
    language: bundle.language.toLowerCase().slice(0, 8),
    mature: matureAfterImport(current.mature, bundle.mature, category?.mature ?? false),
    ...(category ? { categoryId: category.id } : {}),
  };
}

/** A panel's text and link as `setPanels` accepts them (links http(s) only). */
export function panelText(p: BundlePanel): { title: string; body: string; linkUrl: string | null } {
  const link = p.link && /^https?:\/\//i.test(p.link) ? p.link : null;
  return {
    title: redactStreamKeys(p.title).slice(0, 60),
    body: redactStreamKeys(p.body).slice(0, 5000),
    linkUrl: link,
  };
}
