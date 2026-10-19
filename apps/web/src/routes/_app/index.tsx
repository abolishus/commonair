// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, StreamCard } from "@commonair/ui";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { StreamGrid } from "@commonair/ui/blocks/media";
import { buttonVariants } from "@commonair/ui/components/button";
import { PageContainer, ResponsiveGrid } from "@commonair/ui/layouts";
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

function Home(): React.JSX.Element {
  const home = Route.useLoaderData();
  const { me } = useBootstrap();
  const sections = home ? directorySections(home, me !== null) : [];
  return (
    <PageContainer width="wide" className="flex flex-col gap-8 py-8">
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
            <Section
              key={section.id}
              data-testid="directory-section"
              data-section={section.id}
              heading={sectionTitle(section.id)}
            >
              {/* E4a gap: StreamGrid needs per-card props (data-testid, data-channel, showReason) for the
                  e2 selector contract; until then the cards sit in the same ResponsiveGrid by hand. */}
              <ResponsiveGrid cols={4}>
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
              </ResponsiveGrid>
            </Section>
          ))
        )}
      </div>
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
