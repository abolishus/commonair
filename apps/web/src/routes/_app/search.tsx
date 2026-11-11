// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { searchSearch } from "../../components/discovery/search-params.ts";
import { SearchPage } from "../../components/discovery/search-page.tsx";
import { t } from "../../i18n/index.ts";
import { getSearchPage } from "../../lib/directory.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/search?q=` (F1, D3.4): live channels, channels, videos, clips and categories matching the
 * query. An empty query gets its own page: recent searches, live channels, popular categories.
 */
export const Route = createFileRoute("/_app/search")({
  validateSearch: searchSearch,
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) => getSearchPage({ data: { q: deps.q } }),
  head: ({ match }) =>
    titleHead(match.search.q ? t("pageTitle.searchFor", { q: match.search.q }) : t("pageTitle.search")),
  // No pending component: typing re-runs the loader, and the page (with the focused box) must stay.
  component: Search,
});

function Search(): React.JSX.Element {
  const result = Route.useLoaderData();
  const data = result.status === "ok" ? result.data : null;
  const { q } = Route.useSearch();
  return <SearchPage q={q ?? ""} data={data} />;
}
