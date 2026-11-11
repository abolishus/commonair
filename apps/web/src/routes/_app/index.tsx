// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StreamCardSkeleton } from "@commonair/ui";
import { CardGrid } from "@commonair/ui/blocks/media";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { feedViewer } from "../../components/discovery/feed.ts";
import { getHomeCategories, getHomeShelves } from "../../components/discovery/loaders.ts";
import { HomePage } from "../../components/home/home-page.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { getDirectory } from "../../lib/directory.ts";
import { titleHead } from "../../lib/page-title.ts";

export const Route = createFileRoute("/_app/")({
  head: () => titleHead(t("pageTitle.home")),
  // Ranking and viewer counts change on an interval: always refetch when navigating here. Each
  // part fails on its own (D3.1): the shelves that did load still show.
  loader: async () => {
    const [home, categories, shelves] = await Promise.all([getDirectory(), getHomeCategories(), getHomeShelves()]);
    return { home, categories, shelves };
  },
  staleTime: 0,
  pendingMs: 150,
  pendingComponent: HomePending,
  component: Home,
});

function Home(): React.JSX.Element {
  const { home, categories, shelves } = Route.useLoaderData();
  const { me, instance } = useBootstrap();
  return (
    <HomePage
      home={home}
      categories={categories}
      shelves={shelves}
      me={me}
      site={instance.name}
      viewer={feedViewer(me)}
    />
  );
}

/** The first load: the page's shape (feature, then a row of cards), not a spinner. */
function HomePending(): React.JSX.Element {
  return (
    <PageContainer width="wide" className="flex flex-col gap-10 py-6">
      <div aria-busy aria-label={t("directory.loading")} className="flex flex-col gap-10">
        <div className="max-w-4xl">
          <StreamCardSkeleton />
        </div>
        <CardGrid max={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <StreamCardSkeleton key={i} />
          ))}
        </CardGrid>
      </div>
    </PageContainer>
  );
}
