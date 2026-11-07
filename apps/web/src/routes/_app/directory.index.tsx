// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { DirectoryPage } from "../../components/discovery/directory-page.tsx";
import { getDirectoryPage } from "../../components/discovery/loaders.ts";
import { DiscoveryPending } from "../../components/discovery/pending.tsx";
import { directorySearch, directoryView } from "../../components/discovery/search-params.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** `/directory` (F1, decision (a)): categories or live channels; `?tag=` filters the live list. */
export const Route = createFileRoute("/_app/directory/")({
  validateSearch: directorySearch,
  loaderDeps: ({ search }) => ({ tag: search.tag }),
  loader: ({ deps }) => getDirectoryPage({ data: { tag: deps.tag } }),
  head: () => titleHead(t("pageTitle.directory")),
  // Counts move on an interval: refetch on every visit.
  staleTime: 0,
  pendingMs: 150,
  pendingComponent: DiscoveryPending,
  component: Directory,
});

function Directory(): React.JSX.Element {
  const result = Route.useLoaderData();
  const data = result.status === "ok" ? result.data : null;
  const search = Route.useSearch();
  return <DirectoryPage data={data} view={directoryView(search)} tag={search.tag} />;
}
