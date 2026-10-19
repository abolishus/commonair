// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { StreamGrid } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { Link, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { Directory } from "../../components/directory.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { getDirectory } from "../../lib/directory.ts";
import { directorySections } from "../../lib/directory-sections.ts";

export const Route = createFileRoute("/_app/")({
  // Ranking and viewer counts change on an interval: always refetch when navigating here.
  loader: () => getDirectory(),
  staleTime: 0,
  pendingMs: 150,
  pendingComponent: DirectoryPending,
  component: Home,
});

function Home(): React.JSX.Element {
  const home = Route.useLoaderData();
  const { me } = useBootstrap();
  return (
    <PageContainer width="wide" className="flex flex-col gap-8 py-8">
      <Intro />
      <Directory sections={home ? directorySections(home, me !== null) : null} />
    </PageContainer>
  );
}

/** The E1 calls to action, above the directory. */
function Intro(): React.JSX.Element {
  const { me, instance } = useBootstrap();
  return (
    <PageHeader
      title={t("home.title", { name: instance.name })}
      description={t("home.tagline")}
      actions={
        me ? (
          <Button size="lg" nativeButton={false} render={<Link to="/dashboard" />}>
            {t("home.toDashboard")}
          </Button>
        ) : (
          <>
            <Button size="lg" nativeButton={false} render={<Link to="/signup" />}>
              {t("nav.signUp")}
            </Button>
            <Button size="lg" variant="outline" nativeButton={false} render={<Link to="/signin" />}>
              {t("nav.signIn")}
            </Button>
          </>
        )
      }
    />
  );
}

function DirectoryPending(): React.JSX.Element {
  return (
    <PageContainer width="wide" className="flex flex-col gap-8 py-8">
      <Intro />
      <StreamGrid
        streams={[]}
        hrefFor={(stream) => `/${stream.channel.slug}`}
        loading
        loadingCount={8}
        aria-busy
        aria-label={t("directory.loading")}
      />
    </PageContainer>
  );
}
