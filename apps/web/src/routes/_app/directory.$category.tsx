// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute, notFound } from "@tanstack/react-router";
import * as React from "react";
import { clipFilterFrom, type ClipFilter } from "../../components/channel/clip-filters.tsx";
import {
  CategoryLoadFailed,
  CategoryNotFound,
  CategoryPage,
  categoryTabSearch,
  parseCategorySearch,
  type CategoryTab,
} from "../../components/discovery/category-page.tsx";
import { DiscoveryPending } from "../../components/discovery/pending.tsx";
import { t } from "../../i18n/index.ts";
import { getCategoryOverviewPage, type CategoryPageV2Data } from "../../lib/directory.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/directory/$category` (F1, D3.2): one category's header, then its Overview (the bare URL), live
 * channels, videos and clips (`?tab=`).
 */
export const Route = createFileRoute("/_app/directory/$category")({
  validateSearch: parseCategorySearch,
  loader: async ({ params }) => {
    const page = await getCategoryOverviewPage({ data: { slug: params.category } });
    if (!page) throw notFound();
    return page;
  },
  // A tab or filter switch stays on the page: Videos and Clips load their own lists.
  shouldReload: ({ cause }) => cause !== "stay",
  head: ({ loaderData }) =>
    titleHead(
      loaderData?.status === "ok"
        ? t("pageTitle.category", { category: loaderData.data.category.name })
        : t("pageTitle.directory"),
    ),
  staleTime: 0,
  pendingMs: 150,
  pendingComponent: DiscoveryPending,
  notFoundComponent: CategoryNotFound,
  component: Category,
});

function Category(): React.JSX.Element {
  const page = Route.useLoaderData();
  if (page.status === "failed") return <CategoryLoadFailed />;
  return <CategoryLoaded {...page.data} />;
}

function CategoryLoaded({ category, live, overview }: CategoryPageV2Data): React.JSX.Element {
  // Parsed again: unvalidated keys from the raw URL reach `useSearch` beside the validated ones.
  const search = parseCategorySearch(Route.useSearch());
  const { tab: picked } = search;
  const tab: CategoryTab = picked ?? "overview";
  const { sort, range } = clipFilterFrom(search);
  const clipFilter = React.useMemo<ClipFilter>(() => ({ sort, range }), [sort, range]);
  const navigate = Route.useNavigate();
  const onTabChange = React.useCallback(
    (next: CategoryTab) => void navigate({ search: categoryTabSearch(next) }),
    [navigate],
  );
  const onClipFilterChange = React.useCallback(
    (next: ClipFilter) => void navigate({ search: categoryTabSearch("clips", next) }),
    [navigate],
  );
  return (
    <CategoryPage
      key={category.id}
      category={category}
      live={live}
      overview={overview}
      tab={tab}
      clipFilter={clipFilter}
      onTabChange={onTabChange}
      onClipFilterChange={onClipFilterChange}
    />
  );
}
