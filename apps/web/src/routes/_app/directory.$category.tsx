// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute, notFound } from "@tanstack/react-router";
import type * as React from "react";
import { CategoryNotFound, CategoryPage } from "../../components/discovery/category-page.tsx";
import { getCategoryPage } from "../../components/discovery/loaders.ts";
import { DiscoveryPending } from "../../components/discovery/pending.tsx";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** `/directory/$category` (F1): one category's header and its live channels. */
export const Route = createFileRoute("/_app/directory/$category")({
  loader: async ({ params }) => {
    const page = await getCategoryPage({ data: { slug: params.category } });
    if (!page) throw notFound();
    return page;
  },
  head: ({ loaderData }) =>
    titleHead(loaderData ? t("pageTitle.category", { category: loaderData.category.name }) : t("pageTitle.directory")),
  staleTime: 0,
  pendingMs: 150,
  pendingComponent: DiscoveryPending,
  notFoundComponent: CategoryNotFound,
  component: Category,
});

function Category(): React.JSX.Element {
  const { category, live } = Route.useLoaderData();
  return <CategoryPage key={category.id} category={category} live={live} />;
}
