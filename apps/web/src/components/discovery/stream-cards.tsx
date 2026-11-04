// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live stream cards for the discovery pages. `<StreamCard>` is one link to the channel, so the
 * category and tags (which link elsewhere, F1) sit in a row under it instead of inside it; the
 * card gets its stream without them so nothing shows twice.
 */
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { StreamCard, StreamCardSkeleton, type StreamCardProps } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { categoryLink, tagLink } from "../../lib/category-route.ts";
import { displayLabel } from "../../lib/directory-sections.ts";

/** Tags shown per card (StreamCard's own default). */
const MAX_TAGS = 3;

export interface CardLinksProps {
  category: { slug: string; name: string } | null;
  tags?: readonly string[];
  className?: string;
}

/** The category and tag links under a card: each to its category page or the tag filter. */
export function CardLinks({ category, tags = [], className }: CardLinksProps): React.JSX.Element | null {
  const shown = tags.slice(0, MAX_TAGS);
  if (!category && shown.length === 0) return null;
  return (
    <ul
      aria-label={t("discovery.card.links")}
      data-slot="card-links"
      className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs", className)}
    >
      {category && (
        <li className="min-w-0">
          <Link
            {...categoryLink(category.slug)}
            data-testid="card-category-link"
            className="block truncate font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span dir="auto">{category.name}</span>
          </Link>
        </li>
      )}
      {shown.map((tag) => (
        <li key={tag} className="min-w-0">
          <Link
            {...tagLink(tag)}
            data-testid="card-tag-link"
            aria-label={t("discovery.card.tag", { tag })}
            className="block truncate text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span dir="auto">{t("discovery.card.tagText", { tag })}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The stream as the card shows it: the name with `@handle` when it collides, no category or tags. */
export function cardStream(card: StreamCardData, collisions: ReadonlySet<string>): StreamCardData {
  return {
    ...card,
    channel: { ...card.channel, displayName: displayLabel(collisions, card.channel) },
    broadcast: { ...card.broadcast, category: null },
    tags: [],
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
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <StreamCard
        data-testid="stream-card"
        data-channel={card.channel.slug}
        {...data}
        stream={cardStream(card, collisions)}
        href={`/${card.channel.slug}`}
        render={<Link to="/$channel" params={{ channel: card.channel.slug }} />}
        headingLevel={headingLevel}
        lazy={lazy}
        showReason={showReason}
      />
      <CardLinks category={card.broadcast.category} tags={card.tags} className="ps-10" />
    </div>
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
