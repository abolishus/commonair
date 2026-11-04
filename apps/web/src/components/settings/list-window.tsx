// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Long settings lists (F36): a search field over what is loaded, then the house "Load more"
 * paging, which first shows more of the loaded rows and then asks the server for the next page.
 * Used by "Tell me if they move" and "Channels you follow" on `/settings/notifications`.
 */
import { EmptyState } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Search01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";

/** Rows shown at first, and added by each "Load more". */
export const LIST_PAGE_SIZE = 20;

/** Lower case, without accents, trimmed: "Ünïcode " matches "unicode". */
export function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("en").trim();
}

/** Whether any field contains the query (an empty query matches everything). */
export function matchesQuery(query: string, fields: readonly string[]): boolean {
  const q = foldForSearch(query);
  return q === "" || fields.some((f) => foldForSearch(f).includes(q));
}

export interface ListWindowOptions {
  pageSize?: number;
  /** The server has rows that are not loaded yet. */
  serverHasMore?: boolean;
  /** Loads the server's next page (the window grows into it). */
  onServerMore?: () => void;
}

export interface ListWindow<T> {
  query: string;
  setQuery: (query: string) => void;
  /** Every loaded row the query matches. */
  matched: readonly T[];
  /** The part of `matched` on screen. */
  shown: readonly T[];
  hasMore: boolean;
  loadMore: () => void;
}

export function windowRows<T>(
  rows: readonly T[],
  query: string,
  fields: (row: T) => readonly string[],
  limit: number,
): { matched: T[]; shown: T[] } {
  const matched = rows.filter((row) => matchesQuery(query, fields(row)));
  return { matched, shown: matched.slice(0, limit) };
}

export function useListWindow<T>(
  rows: readonly T[] | null,
  fields: (row: T) => readonly string[],
  { pageSize = LIST_PAGE_SIZE, serverHasMore = false, onServerMore }: ListWindowOptions = {},
): ListWindow<T> {
  const [query, setQueryState] = React.useState("");
  const [limit, setLimit] = React.useState(pageSize);
  const { matched, shown } = windowRows(rows ?? [], query, fields, limit);
  const setQuery = (next: string) => {
    setQueryState(next);
    // A new search starts at the first page again.
    setLimit(pageSize);
  };
  return {
    query,
    setQuery,
    matched,
    shown,
    hasMore: matched.length > limit || serverHasMore,
    loadMore: () => {
      // Out of loaded rows for the next page: fetch, and the window grows into the answer.
      if (matched.length < limit + pageSize && serverHasMore) onServerMore?.();
      setLimit((l) => l + pageSize);
    },
  };
}

export function ListSearch({
  label,
  value,
  onValueChange,
  loadedCount,
  partial,
  "data-testid": testId,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** How many rows the search runs over. */
  loadedCount: number;
  /** Some rows are not loaded yet, so the search covers part of the list. */
  partial: boolean;
  "data-testid"?: string;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <Field className="max-w-sm">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="search"
        data-testid={testId}
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        value={value}
        onChange={(e) => onValueChange(e.currentTarget.value)}
      />
      {partial && value.trim() !== "" && (
        <FieldDescription>{t("settings.list.searchLoaded", { count: loadedCount })}</FieldDescription>
      )}
    </Field>
  );
}

/** What a search with no match shows. */
export function NoMatch({ query }: { query: string }): React.JSX.Element {
  return (
    <EmptyState
      data-testid="settings-list-no-match"
      icon={Search01Icon}
      headingLevel={3}
      title={t("settings.list.noMatch", { query: query.trim() })}
      description={t("settings.list.noMatchHint")}
    />
  );
}

export function ListLoadMore({
  onClick,
  loading = false,
  label,
  "data-testid": testId,
}: {
  onClick: () => void;
  loading?: boolean;
  /** Defaults to "Load more". */
  label?: string;
  "data-testid"?: string;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="self-start"
      data-testid={testId}
      disabled={loading}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {label ?? t("settings.list.loadMore")}
    </Button>
  );
}
