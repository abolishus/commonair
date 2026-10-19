// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, SkeletonGroup, StreamCard, StreamCardSkeleton } from "@commonair/ui";
import { buttonVariants } from "@commonair/ui/components/button";
import { AlertCircleIcon, LiveStreaming02Icon } from "@hugeicons/core-free-icons";
import { Link, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { getDirectory } from "../../lib/directory.ts";
import { directorySections, type DirectorySectionId } from "../../lib/directory-sections.ts";

export const Route = createFileRoute("/_app/")({
  // Ranking and viewer counts change on an interval: always refetch when navigating here.
  loader: () => getDirectory(),
  staleTime: 0,
  pendingMs: 150,
  pendingComponent: DirectoryPending,
  component: Home,
});

function sectionTitle(id: DirectorySectionId): string {
  switch (id) {
    case "spotlight":
      return t("directory.section.spotlight");
    case "new":
      return t("directory.section.new");
    case "live":
      return t("directory.section.live");
    case "following":
      return t("directory.section.following");
  }
}

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

function Home(): React.JSX.Element {
  const home = Route.useLoaderData();
  const { me } = useBootstrap();
  const sections = home ? directorySections(home, me !== null) : [];
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-8">
      <Intro />
      <div data-testid="directory" className="flex flex-col gap-8">
        {home === null ? (
          <EmptyState icon={AlertCircleIcon} title={t("directory.loadFailed")} />
        ) : sections.length === 0 ? (
          <EmptyState
            data-testid="directory-empty"
            icon={LiveStreaming02Icon}
            title={t("directory.empty")}
            description={t("directory.emptyHint")}
          />
        ) : (
          sections.map((section, index) => (
            <section
              key={section.id}
              data-testid="directory-section"
              data-section={section.id}
              aria-labelledby={`directory-${section.id}`}
              className="flex flex-col gap-3"
            >
              <h2 id={`directory-${section.id}`} className="font-display text-base font-semibold">
                {sectionTitle(section.id)}
              </h2>
              <div className={GRID}>
                {section.cards.map((card) => (
                  <StreamCard
                    key={card.channel.id}
                    data-testid="stream-card"
                    data-channel={card.channel.slug}
                    stream={card}
                    href={`/${card.channel.slug}`}
                    render={<Link to="/$channel" params={{ channel: card.channel.slug }} />}
                    showReason={section.id !== "following"}
                    lazy={index > 0}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** The E1 calls to action, kept above the directory. */
function Intro(): React.JSX.Element {
  const { me, instance } = useBootstrap();
  return (
    <section className="flex flex-col gap-3">
      <h1 className="font-display text-2xl font-semibold">{t("home.title", { name: instance.name })}</h1>
      <p className="text-sm text-muted-foreground">{t("home.tagline")}</p>
      <div className="flex flex-wrap gap-2">
        {me ? (
          <Link to="/dashboard" className={buttonVariants({ size: "lg" })}>
            {t("home.toDashboard")}
          </Link>
        ) : (
          <>
            <Link to="/signup" className={buttonVariants({ size: "lg" })}>
              {t("nav.signUp")}
            </Link>
            <Link to="/signin" className={buttonVariants({ variant: "outline", size: "lg" })}>
              {t("nav.signIn")}
            </Link>
          </>
        )}
      </div>
    </section>
  );
}

function DirectoryPending(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-8">
      <Intro />
      <SkeletonGroup label={t("directory.loading")} className={GRID}>
        {Array.from({ length: 8 }, (_, i) => (
          <StreamCardSkeleton key={i} />
        ))}
      </SkeletonGroup>
    </div>
  );
}
