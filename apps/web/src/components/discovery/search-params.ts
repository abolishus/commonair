// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The discovery pages' search params: anything malformed is dropped, never an error page. */

export type DirectoryView = "categories" | "live";

export interface DirectorySearch {
  view?: DirectoryView;
  tag?: string;
}

export interface SearchSearch {
  q?: string;
}

/** The API's limits (`ShortText`, `directory.search`'s `q`): 80 characters. */
export const QUERY_MAX = 80;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, QUERY_MAX);
  return trimmed === "" ? undefined : trimmed;
}

export function directorySearch(search: Record<string, unknown>): DirectorySearch {
  const out: DirectorySearch = {};
  if (search.view === "live" || search.view === "categories") out.view = search.view;
  const tag = text(search.tag);
  if (tag !== undefined) out.tag = tag;
  return out;
}

/** A tag filter lists live channels: `?tag=` alone (the `tagHref` seam) opens the Live channels view. */
export function directoryView(search: DirectorySearch): DirectoryView {
  return search.view ?? (search.tag ? "live" : "categories");
}

export function searchSearch(search: Record<string, unknown>): SearchSearch {
  const q = text(search.q);
  return q === undefined ? {} : { q };
}
