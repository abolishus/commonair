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

/** {@link categoryHref} as typed router-link props: `<Link {...categoryLink(slug)} />`. */
export function categoryLink(slug: string): { to: "/directory/$category"; params: { category: string } } {
  return { to: "/directory/$category", params: { category: slug } };
}

/** {@link tagHref} as typed router-link props: `<Link {...tagLink(tag)} />`. */
export function tagLink(tag: string): { to: "/directory"; search: { tag: string } } {
  return { to: "/directory", search: { tag } };
}
