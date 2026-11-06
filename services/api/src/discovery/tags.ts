// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** How many tags a category carries (the contract's "at most 10"). */
export const CATEGORY_TAGS = 10;

/**
 * The most used tags across streams, most used first, ties by name, at most `limit`. Each stream
 * counts a tag once: tags are stored lowercased and deduplicated, but older rows may repeat one.
 */
export function topTags(tagLists: readonly (readonly string[])[], limit = CATEGORY_TAGS): string[] {
  const uses = new Map<string, number>();
  for (const tags of tagLists) for (const t of new Set(tags)) uses.set(t, (uses.get(t) ?? 0) + 1);
  return [...uses]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map(([t]) => t);
}
