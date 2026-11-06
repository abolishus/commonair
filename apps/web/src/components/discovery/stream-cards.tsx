// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live stream cards for the discovery pages. The card's primary link goes to the channel; its
 * category and tags are link slots inside the card (F1), to the category page and the tag filter.
 */
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { StreamCard, StreamCardSkeleton, type StreamCardProps } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { categoryHref, categoryLink, tagHref, tagLink } from "../../lib/category-route.ts";
import { displayLabel } from "../../lib/directory-sections.ts";

/** The stream as the card shows it: the name with `@handle` when it collides. */
export function cardStream(card: StreamCardData, collisions: ReadonlySet<string>): StreamCardData {
  return { ...card, channel: { ...card.channel, displayName: displayLabel(collisions, card.channel) } };
}

/** The card's category and tag slots, as router links (test ids `card-category-link`, `card-tag-link`). */
export function cardLinkSlots(card: StreamCardData): Pick<StreamCardProps, "categoryLink" | "tagLink"> {
  const category = card.broadcast.category;
  return {
    categoryLink: category
      ? {
          href: categoryHref(category.slug),
          render: <Link {...categoryLink(category.slug)} data-testid="card-category-link" />,
        }
      : undefined,
    tagLink: (tag) => ({
      href: tagHref(tag),
      render: <Link {...tagLink(tag)} data-testid="card-tag-link" aria-label={t("discovery.card.tag", { tag })} />,
    }),
  };
}

export interface DiscoveryStreamCardProps extends Pick<StreamCardProps, "headingLevel" | "lazy" | "showReason"> {
  card: StreamCardData;
  collisions?: ReadonlySet<string>;
  className?: string;
  [key: `data-${string}`]: string | undefined;
}

export function DiscoveryStreamCard({
  card,
  collisions = new Set(),
  headingLevel = 3,
  lazy,
  showReason = true,
  className,
  ...data
}: DiscoveryStreamCardProps): React.JSX.Element {
  return (
    <StreamCard
      data-testid="stream-card"
      data-channel={card.channel.slug}
      {...data}
      stream={cardStream(card, collisions)}
      href={`/${card.channel.slug}`}
      render={<Link to="/$channel" params={{ channel: card.channel.slug }} />}
      {...cardLinkSlots(card)}
      headingLevel={headingLevel}
      lazy={lazy}
      showReason={showReason}
      className={className}
    />
  );
}

export interface DiscoveryStreamGridProps extends Omit<React.ComponentProps<"div">, "children"> {
  cards: StreamCardData[];
  collisions?: ReadonlySet<string>;
  showReason?: boolean;
  headingLevel?: 2 | 3 | 4;
  /** Cards before this index load eagerly (the first row). */
  eager?: number;
  loading?: boolean;
  loadingCount?: number;
  dense?: boolean;
}

export function DiscoveryStreamGrid({
  cards,
  collisions,
  showReason = true,
  headingLevel = 3,
  eager = 3,
  loading = false,
  loadingCount = 6,
  dense = false,
  className,
  ...props
}: DiscoveryStreamGridProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2",
        dense ? "lg:grid-cols-3 2xl:grid-cols-4" : "lg:grid-cols-3",
        className,
      )}
      {...props}
    >
      {loading
        ? Array.from({ length: loadingCount }, (_, i) => <StreamCardSkeleton key={i} />)
        : cards.map((card, index) => (
            <DiscoveryStreamCard
              key={card.channel.id}
              card={card}
              collisions={collisions}
              showReason={showReason}
              headingLevel={headingLevel}
              lazy={index >= eager}
            />
          ))}
    </div>
  );
}
