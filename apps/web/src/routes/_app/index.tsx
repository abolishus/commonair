// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StreamCardSkeleton } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { Link, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { Directory } from "../../components/directory.tsx";
import { primeHomeFeed } from "../../components/discovery/feed.ts";
import { getHomeCategories } from "../../components/discovery/loaders.ts";
import { WelcomeStrip } from "../../components/discovery/welcome-strip.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { getDirectory } from "../../lib/directory.ts";
import { homeLayout } from "../../lib/directory-sections.ts";
import { titleHead } from "../../lib/page-title.ts";

export const Route = createFileRoute("/_app/")({
  head: () => titleHead(t("pageTitle.home")),
  // Ranking and viewer counts change on an interval: always refetch when navigating here.
  loader: async () => {
    const [home, categories] = await Promise.all([getDirectory(), getHomeCategories()]);
    return { home, categories };
  },
  staleTime: 0,
  pendingMs: 150,
  pendingComponent: DirectoryPending,
  component: Home,
});

function Home(): React.JSX.Element {
  const { home, categories } = Route.useLoaderData();
  const { me } = useBootstrap();
  const signedIn = me !== null;
  // The rail and the sheet read the same `directory.home`: hand them this copy. A layout effect,
  // so it lands before the header's and the rail's subscribe effects and they do not ask again.
  React.useLayoutEffect(() => {
    if (home) primeHomeFeed(home);
  }, [home]);
  const layout = React.useMemo(() => (home ? homeLayout(home, signedIn) : null), [home, signedIn]);
  return (
    <PageContainer width="wide" className="flex flex-col gap-8 py-6">
      <h1 className="sr-only">{t("pageTitle.home")}</h1>
      <Intro />
      <Directory
        sections={layout ? layout.sections : null}
        hero={layout?.hero ?? null}
        categoryShelves={layout?.categoryShelves ?? []}
        offline={layout?.offline ?? []}
        categories={categories}
        emptyAction={
          signedIn ? (
            <Button nativeButton={false} render={<Link to="/dashboard" />}>
              {t("home.toDashboard")}
            </Button>
          ) : (
            <Button nativeButton={false} render={<Link to="/signup" />}>
              {t("nav.signUp")}
            </Button>
          )
        }
      />
    </PageContainer>
  );
}

/** Signed out: the slim, dismissible welcome (F8). Signed in: nothing; the dashboard is in the account menu. */
function Intro(): React.JSX.Element | null {
  const { me, instance } = useBootstrap();
  if (me) return null;
  return <WelcomeStrip name={instance.name} />;
}

function DirectoryPending(): React.JSX.Element {
  return (
    <PageContainer width="wide" className="flex flex-col gap-8 py-6">
      <Intro />
      <div aria-busy aria-label={t("directory.loading")} className="flex flex-col gap-8">
        <div className="max-w-4xl">
          <StreamCardSkeleton />
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <StreamCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </PageContainer>
  );
}
