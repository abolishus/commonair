// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The clips sort and range controls (`clip-filters`, `clip-sort-<id>`, `clip-range-<id>`), shared by
 * the channel's Clips tab and the category page's Clips tab. Both keep the choice in the URL
 * (`?sort=top&range=7d`); the defaults (recent, all time) are the bare URL.
 */
import type { CLIP_RANGES as CONTRACT_CLIP_RANGES } from "@commonair/contracts/api";
import { ToggleGroup, ToggleGroupItem } from "@commonair/ui/components/toggle-group";
import * as React from "react";
import { t } from "../../i18n/index.ts";

export type ClipSort = "recent" | "top";
export type ClipRange = (typeof CONTRACT_CLIP_RANGES)[number];
// Kept here (type-checked against the contract) so the client bundle never loads the router.
export const CLIP_RANGES = ["7d", "30d", "all"] as const satisfies readonly ClipRange[];
export const CLIP_SORTS: readonly ClipSort[] = ["recent", "top"];

export interface ClipFilter {
  sort: ClipSort;
  range: ClipRange;
}

export const DEFAULT_CLIP_FILTER: ClipFilter = Object.freeze({ sort: "recent", range: "all" });

/** The search params a filter adds; the defaults add nothing, so the canonical URL stays short. */
export interface ClipFilterSearch {
  sort?: "top";
  range?: Exclude<ClipRange, "all">;
}

export function parseClipFilter(search: Record<string, unknown>): ClipFilterSearch {
  const out: ClipFilterSearch = {};
  if (search.sort === "top") out.sort = "top";
  if (search.range === "7d" || search.range === "30d") out.range = search.range;
  return out;
}

export function clipFilterFrom(search: ClipFilterSearch): ClipFilter {
  return { sort: search.sort ?? "recent", range: search.range ?? "all" };
}

export function clipFilterSearch(filter: ClipFilter): ClipFilterSearch {
  return {
    ...(filter.sort === "top" ? { sort: "top" as const } : {}),
    ...(filter.range !== "all" ? { range: filter.range } : {}),
  };
}

export function isDefaultClipFilter(filter: ClipFilter): boolean {
  return filter.sort === "recent" && filter.range === "all";
}

function sortLabel(sort: ClipSort): string {
  return sort === "top" ? t("fuChannel.clips.sortTop") : t("fuChannel.clips.sortRecent");
}

function rangeLabel(range: ClipRange): string {
  switch (range) {
    case "7d":
      return t("fuChannel.clips.range7d");
    case "30d":
      return t("fuChannel.clips.range30d");
    case "all":
      return t("fuChannel.clips.rangeAll");
  }
}

/** Two single-choice groups; picking the active option again keeps it (never an empty choice). */
export function ClipFilters({
  value,
  onChange,
}: {
  value: ClipFilter;
  onChange: (next: ClipFilter) => void;
}): React.JSX.Element {
  const ids = React.useId();
  return (
    <div data-testid="clip-filters" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <span id={`${ids}-sort`} className="text-xs text-muted-foreground">
          {t("fuChannel.clips.sortLabel")}
        </span>
        <ToggleGroup
          aria-labelledby={`${ids}-sort`}
          variant="outline"
          size="sm"
          spacing={0}
          multiple={false}
          value={[value.sort]}
          onValueChange={(values) => {
            const next = values.at(-1) as ClipSort | undefined;
            if (next && next !== value.sort) onChange({ ...value, sort: next });
          }}
        >
          {CLIP_SORTS.map((sort) => (
            <ToggleGroupItem key={sort} value={sort} data-testid={`clip-sort-${sort}`}>
              {sortLabel(sort)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span id={`${ids}-range`} className="text-xs text-muted-foreground">
          {t("fuChannel.clips.rangeLabel")}
        </span>
        <ToggleGroup
          aria-labelledby={`${ids}-range`}
          variant="outline"
          size="sm"
          spacing={0}
          multiple={false}
          value={[value.range]}
          onValueChange={(values) => {
            const next = values.at(-1) as ClipRange | undefined;
            if (next && next !== value.range) onChange({ ...value, range: next });
          }}
        >
          {CLIP_RANGES.map((range) => (
            <ToggleGroupItem key={range} value={range} data-testid={`clip-range-${range}`}>
              {rangeLabel(range)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </div>
  );
}
