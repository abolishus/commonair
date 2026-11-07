// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Category, ChannelCard, StreamCard } from "@commonair/contracts/dto";
import { ChannelAvatar, EmptyState, formatDuration, OverlayBadge, RelativeTime } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { AlertCircleIcon, ArrowRight01Icon, LiveStreaming02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../i18n/index.ts";
import { RouteSectionLoadError } from "../lib/section-load-error.tsx";
import { categoryLink } from "../lib/category-route.ts";
import {
  collidingNames,
  displayLabel,
  type CategoryShelf,
  type DirectorySection,
  type DirectorySectionId,
  type OfflineSection,
  type OfflineSectionId,
} from "../lib/directory-sections.ts";
import { DiscoveryCategoryGrid } from "./discovery/category-tiles.tsx";
import { DiscoveryStreamCard, DiscoveryStreamGrid } from "./discovery/stream-cards.tsx";

/** With the hero shown, the rest of Spotlight gets its own heading, so the outline has one "Spotlight". */
function sectionTitle(id: DirectorySectionId, hasHero: boolean): string {
  switch (id) {
    case "spotlight":
      return hasHero ? t("discovery.home.moreSpotlight") : t("directory.section.spotlight");
    case "new":
      return t("directory.section.new");
    case "live":
      return t("directory.section.live");
    case "following":
      return t("directory.section.following");
  }
}

function offlineTitle(id: OfflineSectionId): string {
  switch (id) {
    case "following-offline":
      return t("directory.section.followingOffline");
    case "recent":
      return t("directory.section.recent");
  }
}

export interface DirectoryProps {
  /** The live shelves; null when loading failed. */
  sections: DirectorySection[] | null;
  offline?: OfflineSection[];
  /** The one Spotlight hero (F8). */
  hero?: StreamCard | null;
  /** The busiest categories, for the Categories shelf. */
  categories?: Category[];
  /** The categories did not load: the shelf says so, with Retry, instead of hiding. */
  categoriesFailed?: boolean;
  /** Categories with enough live channels for a shelf of their own. */
  categoryShelves?: CategoryShelf[];
  /** The way forward when nothing is live (start streaming, sign up). */
  emptyAction?: React.ReactNode;
}

/** Tiles on the home page's Categories shelf (F8: 6–8). */
const HOME_CATEGORIES = 8;

/**
 * The front page's directory (F8): the Spotlight hero, the live shelves (each channel once), the
 * Categories shelf, per-category shelves with "Show all", then the offline shelves. Names that two
 * channels on the page share show their `@handle`.
 */
export function Directory({
  sections,
  offline = [],
  hero = null,
  categories = [],
  categoriesFailed = false,
  categoryShelves = [],
  emptyAction,
}: DirectoryProps): React.JSX.Element {
  const collisions = collidingNames(
    [
      ...(hero ? [hero] : []),
      ...(sections ?? []).flatMap((s) => s.cards),
      ...categoryShelves.flatMap((s) => s.cards),
      ...offline.flatMap((s) => s.cards),
    ].map((c) => c.channel),
  );
  const liveCategories = categories.filter((c) => c.liveChannels > 0).slice(0, HOME_CATEGORIES);
  const nothingLive = hero === null && (sections ?? []).length === 0 && categoryShelves.length === 0;
  return (
    <div data-testid="directory" className="flex flex-col gap-10">
      {sections === null ? (
        <EmptyState icon={AlertCircleIcon} title={t("directory.loadFailed")} />
      ) : nothingLive ? (
        <EmptyState
          data-testid="directory-empty"
          icon={LiveStreaming02Icon}
          title={t("directory.empty")}
          description={t("directory.emptyHint")}
          action={emptyAction}
        />
      ) : null}
      {sections !== null && hero && (
        <Section
          data-testid="home-hero"
          data-section="spotlight-hero"
          heading={t("directory.section.spotlight")}
          description={t("discovery.home.spotlightHint")}
        >
          <DiscoveryStreamCard
            card={hero}
            collisions={collisions}
            lazy={false}
            headingLevel={3}
            className="max-w-4xl"
          />
        </Section>
      )}
      {sections?.map((section) => (
        <Section
          key={section.id}
          data-testid="directory-section"
          data-section={section.id}
          heading={sectionTitle(section.id, Boolean(hero))}
        >
          <DiscoveryStreamGrid cards={section.cards} collisions={collisions} showReason={section.id !== "following"} />
        </Section>
      ))}
      {sections !== null && categoriesFailed && (
        <RouteSectionLoadError data-testid="home-categories-load-error" section={t("discovery.home.categories")} />
      )}
      {sections !== null && !categoriesFailed && liveCategories.length > 0 && (
        <Section
          data-testid="home-categories-shelf"
          heading={t("discovery.home.categories")}
          action={<ShowAll to="/directory" label={t("discovery.home.allCategories")} />}
        >
          <DiscoveryCategoryGrid categories={liveCategories} columns={6} />
        </Section>
      )}
      {sections !== null &&
        categoryShelves.map((shelf) => (
          <Section
            key={shelf.category.id}
            data-testid="directory-section"
            data-section="category"
            data-category={shelf.category.slug}
            heading={shelf.category.name}
            action={
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link {...categoryLink(shelf.category.slug)} />}
                aria-label={t("discovery.home.showAllIn", { category: shelf.category.name })}
              >
                {t("discovery.home.showAll")}
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden className="rtl:-scale-x-100" />
              </Button>
            }
          >
            <DiscoveryStreamGrid cards={shelf.cards} collisions={collisions} />
          </Section>
        ))}
      {sections !== null &&
        offline.map((section) => (
          <Section
            key={section.id}
            data-testid="directory-section"
            data-section={section.id}
            heading={offlineTitle(section.id)}
          >
            <ul className="grid min-w-0 grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {section.cards.map((card) => (
                <li key={card.channel.id} className="min-w-0">
                  <RecentTile card={card} collisions={collisions} recent={section.id === "recent"} />
                </li>
              ))}
            </ul>
          </Section>
        ))}
    </div>
  );
}

function ShowAll({ to, label }: { to: "/directory"; label: string }): React.JSX.Element {
  return (
    <Button variant="ghost" size="sm" nativeButton={false} render={<Link to={to} />}>
      {label}
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden className="rtl:-scale-x-100" />
    </Button>
  );
}

/**
 * An offline channel: a 16:9 tile, its name, last title and when it was last live, then its
 * category as a link. With a watchable VOD the tile is that VOD's thumbnail and length, a link of
 * its own to the VOD (`channel-card-vod`); without one it is the initial avatar on the channel's
 * accent inside the channel link.
 */
function RecentTile({
  card,
  collisions,
  recent,
}: {
  card: ChannelCard;
  collisions: ReadonlySet<string>;
  recent: boolean;
}): React.JSX.Element {
  const vod = card.latestVod;
  const avatarFrame = (
    <span
      data-accent={card.channel.accent}
      className="grid aspect-video w-full place-items-center overflow-hidden bg-channel-accent/15 ring-channel-accent transition-shadow group-hover:ring-2"
    >
      <ChannelAvatar
        name={card.channel.displayName}
        src={card.channel.avatarUrl}
        accent={card.channel.accent}
        size="lg"
        decorative
      />
    </span>
  );
  const focus =
    "group rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
  return (
    <div data-testid={recent ? "home-recent-tile" : undefined} className="flex min-w-0 flex-col gap-2">
      {vod ? (
        <Link
          to="/$channel/vods/$vodId"
          params={{ channel: card.channel.slug, vodId: vod.id }}
          data-testid="channel-card-vod"
          data-vod={vod.id}
          aria-label={t("fuChannel.recent.watchLatest", {
            name: card.channel.displayName,
            duration: formatDuration(vod.durationSeconds),
          })}
          className={cn("relative block min-w-0", focus)}
        >
          {vod.thumbnailUrl ? (
            <span className="block aspect-video w-full overflow-hidden bg-muted">
              <img
                src={vod.thumbnailUrl}
                alt=""
                loading="lazy"
                decoding="async"
                className="size-full object-cover transition-opacity group-hover:opacity-90"
              />
            </span>
          ) : (
            avatarFrame
          )}
          <OverlayBadge size="sm" className="absolute end-2 bottom-2">
            {formatDuration(vod.durationSeconds)}
          </OverlayBadge>
        </Link>
      ) : null}
      <Link
        to="/$channel"
        params={{ channel: card.channel.slug }}
        data-testid="channel-card"
        data-channel={card.channel.slug}
        className={cn("flex min-w-0 flex-col gap-2", focus)}
      >
        {vod ? null : avatarFrame}
        <span className="flex min-w-0 flex-col">
          <span dir="auto" className="truncate text-sm font-medium">
            {displayLabel(collisions, card.channel)}
          </span>
          {card.title && (
            <span dir="auto" className="truncate text-xs text-muted-foreground">
              {card.title}
            </span>
          )}
          <span className="truncate text-xs text-muted-foreground">
            {card.lastLiveAt ? (
              <>
                {t("directory.lastLive")} <RelativeTime date={card.lastLiveAt} tooltip={false} />
              </>
            ) : (
              t("directory.neverLive")
            )}
          </span>
        </span>
      </Link>
      {card.category && (
        <Link
          {...categoryLink(card.category.slug)}
          data-testid="card-category-link"
          className="max-w-full self-start truncate text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span dir="auto">{card.category.name}</span>
        </Link>
      )}
    </div>
  );
}
