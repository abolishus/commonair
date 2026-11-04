// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { getSearch } from "../../components/discovery/loaders.ts";
import { searchSearch } from "../../components/discovery/search-params.ts";
import { SearchPage } from "../../components/discovery/search-page.tsx";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** `/search?q=` (F1): channels and categories matching the query. An empty query asks nothing. */
export const Route = createFileRoute("/_app/search")({
  validateSearch: searchSearch,
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) => getSearch({ data: { q: deps.q } }),
  head: ({ match }) =>
    titleHead(match.search.q ? t("pageTitle.searchFor", { q: match.search.q }) : t("pageTitle.search")),
  // No pending component: typing re-runs the loader, and the page (with the focused box) must stay.
  component: Search,
});

function Search(): React.JSX.Element {
  const results = Route.useLoaderData();
  const { q } = Route.useSearch();
  return <SearchPage q={q ?? ""} results={results} />;
}
