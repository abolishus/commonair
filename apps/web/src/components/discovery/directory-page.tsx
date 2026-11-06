// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/directory` (F1): every category, busiest first, or every live channel, with a tag filter and
 * "Show more" (a button, not infinite scroll, so the footer stays reachable).
 */
import type { Category, StreamCard } from "@commonair/contracts/dto";
import { EmptyState } from "@commonair/ui";
import { PageHeader, PageTabs } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@commonair/ui/components/combobox";
import { Label } from "@commonair/ui/components/label";
import { toast } from "@commonair/ui/toast";
import { PageContainer } from "@commonair/ui/layouts";
import { AlertCircleIcon, GridViewIcon, LiveStreaming02Icon } from "@hugeicons/core-free-icons";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { appendPage, collidingNames, sortCategories, tagOptions } from "../../lib/directory-sections.ts";
import { DiscoveryCategoryGrid } from "./category-tiles.tsx";
import { CATEGORY_PAGE, LIVE_PAGE, type DirectoryPageData, type Page } from "./loaders.ts";
import type { DirectoryView } from "./search-params.ts";
import { DiscoveryStreamGrid } from "./stream-cards.tsx";

export interface DirectoryPageProps {
  data: DirectoryPageData | null;
  view: DirectoryView;
  tag?: string;
}

export function DirectoryPage({ data, view, tag }: DirectoryPageProps): React.JSX.Element {
  return (
    <PageContainer width="wide" data-testid="directory-page" className="flex flex-col gap-6 py-6">
      <PageHeader
        title={t("discovery.directory.title")}
        description={t("discovery.directory.description")}
        tabs={
          <PageTabs
            aria-label={t("discovery.directory.views")}
            items={[
              {
                id: "categories",
                label: t("discovery.directory.categories"),
                current: view === "categories",
                render: <Link to="/directory" search={{ view: "categories" }} />,
                "data-testid": "directory-view-categories",
              },
              {
                id: "live",
                label: t("discovery.directory.live"),
                current: view === "live",
                render: <Link to="/directory" search={tag ? { view: "live", tag } : { view: "live" }} />,
                "data-testid": "directory-view-live",
              },
            ]}
          />
        }
      />
      {data === null ? (
        <EmptyState icon={AlertCircleIcon} title={t("discovery.directory.loadFailed")} />
      ) : (
        <>
          <TagFilter options={tagOptions(data.live.items)} tag={tag} />
          {view === "categories" ? (
            <CategoriesView key="categories" initial={data.categories} />
          ) : (
            <LiveView key={tag ?? ""} initial={(tag ? data.tagged : undefined) ?? data.live} tag={tag} />
          )}
        </>
      )}
    </PageContainer>
  );
}

/**
 * Filter by tag (a combobox of the tags on every live channel, not only the filtered ones, so the
 * viewer can switch tags directly). Picking one lists the live channels with it.
 */
export function TagFilter({ options, tag }: { options: string[]; tag?: string }): React.JSX.Element {
  const navigate = useNavigate();
  const id = React.useId();
  const items = tag && !options.some((o) => o.toLowerCase() === tag.toLowerCase()) ? [tag, ...options] : options;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="directory-tag-filter">
      <Label htmlFor={id}>{t("discovery.directory.tagLabel")}</Label>
      <Combobox
        items={items}
        value={tag ?? null}
        onValueChange={(next: unknown) => {
          const picked = typeof next === "string" && next !== "" ? next : undefined;
          void navigate({ to: "/directory", search: picked ? { view: "live", tag: picked } : { view: "live" } });
        }}
      >
        <ComboboxInput
          id={id}
          placeholder={t("discovery.directory.tagPlaceholder")}
          showClear={tag !== undefined}
          className="w-full sm:w-64"
        />
        <ComboboxContent>
          <ComboboxEmpty>{t("discovery.directory.tagEmpty")}</ComboboxEmpty>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

function ShowMore({ onClick, busy }: { onClick: () => void; busy: boolean }): React.JSX.Element {
  return (
    <Button
      data-testid="directory-show-more"
      variant="outline"
      className="self-center"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
    >
      {busy ? t("discovery.directory.loadingMore") : t("discovery.directory.showMore")}
    </Button>
  );
}

/** The category grid, sorted by live channels then viewers; totals and tags are the API's. */
export function CategoriesView({ initial }: { initial: Page<Category> }): React.JSX.Element {
  const [items, setItems] = React.useState(initial.items);
  const [cursor, setCursor] = React.useState(initial.nextCursor);
  const [busy, setBusy] = React.useState(false);
  const sorted = React.useMemo(() => sortCategories(items), [items]);
  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await api().categories.list({ cursor, limit: CATEGORY_PAGE });
      setItems((list) => appendPage(list, page.items, (c) => c.id));
      setCursor(page.nextCursor);
    } catch {
      toast.error(t("discovery.directory.moreFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t("discovery.directory.categories")} className="flex flex-col gap-6">
      <DiscoveryCategoryGrid
        data-testid="directory-category-grid"
        categories={sorted}
        columns={6}
        empty={<EmptyState icon={GridViewIcon} title={t("discovery.directory.noCategories")} />}
      />
      {cursor && <ShowMore onClick={() => void more()} busy={busy} />}
    </section>
  );
}

/** Every live channel (or those with `tag`, or in `category`), most viewers first, 24 more at a time. */
export function LiveView({
  initial,
  tag,
  category,
  empty,
}: {
  initial: Page<StreamCard>;
  tag?: string;
  category?: string;
  /** Replaces the default empty state. */
  empty?: React.ReactNode;
}): React.JSX.Element {
  const [items, setItems] = React.useState(initial.items);
  const [cursor, setCursor] = React.useState(initial.nextCursor);
  const [visible, setVisible] = React.useState(LIVE_PAGE);
  const [busy, setBusy] = React.useState(false);
  const shown = items.slice(0, visible);
  const collisions = React.useMemo(() => collidingNames(shown.map((c) => c.channel)), [shown]);
  const more = async () => {
    if (visible < items.length) {
      setVisible((n) => n + LIVE_PAGE);
      return;
    }
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await api().directory.live({
        cursor,
        limit: LIVE_PAGE,
        sort: "viewers_desc",
        ...(tag ? { tag } : {}),
        ...(category ? { category } : {}),
      });
      setItems((list) => appendPage(list, page.items, (c) => c.channel.id));
      setCursor(page.nextCursor);
      setVisible((n) => n + LIVE_PAGE);
    } catch {
      toast.error(t("discovery.directory.moreFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t("discovery.directory.live")} className="flex flex-col gap-6" data-testid="directory-live">
      {items.length === 0 ? (
        (empty ?? (
          <EmptyState
            icon={LiveStreaming02Icon}
            title={tag ? t("discovery.directory.noLiveTag", { tag }) : t("directory.empty")}
            action={
              tag ? (
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<Link to="/directory" search={{ view: "live" }} />}
                >
                  {t("discovery.directory.clearTag")}
                </Button>
              ) : undefined
            }
          />
        ))
      ) : (
        <DiscoveryStreamGrid cards={shown} collisions={collisions} showReason={false} dense />
      )}
      {(visible < items.length || cursor) && <ShowMore onClick={() => void more()} busy={busy} />}
    </section>
  );
}
