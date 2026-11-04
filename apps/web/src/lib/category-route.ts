// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Links into the directory (D1-web owns `/directory/$category`; other pages link through these so
 * the URL shape lives in one place). Contract-step seam for D wave 2.
 */
export function categoryHref(slug: string): string {
  return `/directory/${encodeURIComponent(slug)}`;
}

/** The directory filtered to one tag. */
export function tagHref(tag: string): string {
  return `/directory?tag=${encodeURIComponent(tag)}`;
}
