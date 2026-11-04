// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Book02Icon,
  BubbleChatIcon,
  ChefHatIcon,
  Dumbbell01Icon,
  FootballIcon,
  GameController03Icon,
  Globe02Icon,
  GridViewIcon,
  Mic01Icon,
  MusicNote01Icon,
  PaintBrush01Icon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Badge } from "@commonair/ui/components/badge";
import { Card } from "@commonair/ui/components/card";
import { OverlayBadge, Skeleton, formatCompactNumber } from "@commonair/ui";
import type { Accent } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";
import { useResolvedLocale } from "@commonair/ui/lib/locale";

export interface CategoryTileData {
  id: string;
  /** The URL slug; the fallback art is derived from it (else from `id`), so it never changes between renders. */
  slug?: string;
  name: string;
  liveCount: number;
  /** Verified viewers across the category's live channels; leave out when the total is not known exactly. */
  viewers?: number;
  imageUrl?: string | null;
  /** A channel accent for the fallback; without one the fallback picks a chart token from the slug. */
  accent?: Accent;
  tags?: string[];
}

/** What a category is about, as far as its slug or name tells: picks the fallback glyph. */
export type CategoryKind =
  | "art"
  | "music"
  | "games"
  | "talk"
  | "tech"
  | "sports"
  | "food"
  | "fitness"
  | "learning"
  | "travel"
  | "podcast"
  | "other";

const KIND_WORDS: readonly [CategoryKind, readonly string[]][] = [
  ["podcast", ["podcast"]],
  ["art", ["art", "draw", "paint", "craft", "maker", "design", "illustrat", "anim"]],
  ["music", ["music", "dj", "sing", "song", "band", "audio"]],
  ["talk", ["chat", "talk", "irl", "just-chatting", "social"]],
  ["tech", ["code", "coding", "software", "dev", "program", "tech", "science"]],
  ["food", ["food", "cook", "drink", "kitchen", "bake"]],
  ["fitness", ["fitness", "health", "workout", "yoga"]],
  ["sports", ["sport", "football", "soccer", "chess", "racing"]],
  ["learning", ["learn", "educat", "study", "book", "read", "history", "lang"]],
  ["travel", ["travel", "outdoor", "nature", "walk"]],
  ["games", ["game", "gaming", "rpg", "speedrun", "retro", "tabletop", "strategy", "tactics", "play"]],
];

const KIND_ICONS: Record<CategoryKind, IconSvgElement> = {
  art: PaintBrush01Icon,
  music: MusicNote01Icon,
  games: GameController03Icon,
  talk: BubbleChatIcon,
  tech: SourceCodeIcon,
  sports: FootballIcon,
  food: ChefHatIcon,
  fitness: Dumbbell01Icon,
  learning: Book02Icon,
  travel: Globe02Icon,
  podcast: Mic01Icon,
  other: GridViewIcon,
};

/**
 * Text-safe chart tokens in both themes (globals.css: chart-1..6 and chart-8 pass 4.5:1 on the
 * light background; chart-7 is graphics-only). Full class strings so Tailwind sees them.
 */
const TONES = [
  "bg-chart-1/15 text-chart-1",
  "bg-chart-2/15 text-chart-2",
  "bg-chart-3/15 text-chart-3",
  "bg-chart-4/15 text-chart-4",
  "bg-chart-5/15 text-chart-5",
  "bg-chart-6/15 text-chart-6",
] as const;

/** FNV-1a over UTF-16 code units: small, stable across runtimes, good enough to spread slugs. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** By word prefix, so "starfall" is not "art": the first kind with a matching word wins. */
export function categoryKind(slugOrName: string): CategoryKind {
  const tokens = slugOrName.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  for (const [kind, words] of KIND_WORDS) if (tokens.some((tok) => words.some((w) => tok.startsWith(w)))) return kind;
  return "other";
}

/** The generated tile for a category without box art: the same tone and glyph for the same slug, always. */
export function categoryFallback(slug: string): { tone: number; kind: CategoryKind } {
  return { tone: hash(slug) % TONES.length, kind: categoryKind(slug) };
}

export interface CategoryArtProps extends Omit<React.ComponentProps<"span">, "children"> {
  slug: string;
  imageUrl?: string | null;
  accent?: Accent;
  /** Glyph size; the art itself fills its box. */
  iconSize?: "sm" | "md" | "lg";
}

/** Box art, or the generated token-coloured tile with a glyph for the category's kind (F10). */
export function CategoryArt({
  slug,
  imageUrl,
  accent,
  iconSize = "md",
  className,
  ...props
}: CategoryArtProps): React.JSX.Element {
  if (imageUrl)
    return (
      <span data-slot="category-art" className={cn("block size-full", className)} {...props}>
        <img src={imageUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
      </span>
    );
  const { tone, kind } = categoryFallback(slug);
  const icon = { sm: "size-4", md: "size-6", lg: "size-10" }[iconSize];
  return (
    <span
      data-slot="category-art"
      data-fallback={kind}
      data-tone={accent ? undefined : tone}
      data-accent={accent}
      aria-hidden
      className={cn(
        "grid size-full place-items-center",
        accent ? "bg-channel-accent/15 text-channel-accent-foreground" : TONES[tone],
        className,
      )}
      {...props}
    >
      <HugeiconsIcon icon={KIND_ICONS[kind]} strokeWidth={1.5} aria-hidden className={icon} />
    </span>
  );
}

export interface CategoryTileProps extends Omit<React.ComponentProps<"article">, "children"> {
  category: CategoryTileData;
  href?: string;
  render?: useRender.RenderProp;
  size?: "default" | "sm";
  layout?: "tile" | "chip";
  locale?: string;
  liveLabel: (formatted: string, count: number) => string;
  viewerLabel: (formatted: string, count: number) => string;
  /** Tags shown as chips under the name (the tile is one link, so the chips are not links). */
  maxTags?: number;
}

export function CategoryTile({
  category,
  href,
  render,
  size = "default",
  layout = "tile",
  locale,
  liveLabel,
  viewerLabel,
  maxTags = 2,
  className,
  ...props
}: CategoryTileProps): React.JSX.Element {
  const resolvedLocale = useResolvedLocale(locale);
  const chip = layout === "chip";
  const tags = (category.tags ?? []).slice(0, Math.max(0, maxTags));
  const link = useRender({
    defaultTagName: href ? "a" : "div",
    render,
    props: {
      href,
      "data-slot": "category-tile-link",
      className: cn(
        "group block min-w-0 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
        chip && "flex items-center gap-2",
      ),
      children: (
        <>
          <AspectRatio
            ratio={chip ? 1 : 3 / 4}
            className={cn("overflow-hidden bg-muted", chip ? "size-10 shrink-0" : "relative w-full")}
          >
            <CategoryArt
              slug={category.slug ?? category.id}
              imageUrl={category.imageUrl}
              accent={category.accent}
              iconSize={chip ? "sm" : "lg"}
              className="transition-transform motion-safe:group-hover:scale-105"
            />
            {!chip && (
              <OverlayBadge size="sm" className="absolute end-2 bottom-2">
                {liveLabel(formatCompactNumber(category.liveCount, resolvedLocale), category.liveCount)}
              </OverlayBadge>
            )}
          </AspectRatio>
          <span className={cn("flex min-w-0 flex-col", chip ? "flex-1" : "mt-2")}>
            <span
              dir="auto"
              className={cn(
                "font-medium break-words",
                chip ? "truncate" : "line-clamp-2",
                size === "sm" ? "text-xs" : "text-sm",
              )}
            >
              {category.name}
            </span>
            {category.viewers !== undefined && (
              <span className="text-xs text-muted-foreground">
                {viewerLabel(formatCompactNumber(category.viewers, resolvedLocale), category.viewers)}
              </span>
            )}
            {chip && (
              <span className="text-2xs text-muted-foreground">
                {liveLabel(formatCompactNumber(category.liveCount, resolvedLocale), category.liveCount)}
              </span>
            )}
          </span>
        </>
      ),
    },
  });
  return (
    <article data-slot="category-tile" className={cn("min-w-0", className)} {...props}>
      {chip ? (
        link
      ) : (
        <Card size={size === "sm" ? "sm" : "default"} className="min-w-0 gap-2 p-2">
          {link}
          {tags.length ? (
            <ul className="flex min-w-0 flex-wrap gap-1">
              {tags.map((tag) => (
                <li key={tag} className="min-w-0">
                  <Badge variant="outline" className="max-w-full">
                    <span dir="auto" className="truncate">
                      {tag}
                    </span>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      )}
    </article>
  );
}

export interface CategoryGridProps extends React.ComponentProps<"div"> {
  categories: CategoryTileData[];
  hrefFor?: (category: CategoryTileData) => string;
  /** A router link per tile (Base UI `render`); `hrefFor` stays the plain-anchor fallback. */
  renderLink?: (category: CategoryTileData) => React.ReactElement;
  /** Extra props per tile (`data-*` test ids). */
  tileProps?: (category: CategoryTileData) => { [key: `data-${string}`]: string | undefined };
  columns?: 2 | 3 | 4 | 6;
  liveLabel: CategoryTileProps["liveLabel"];
  viewerLabel: CategoryTileProps["viewerLabel"];
  /** Placeholder tiles while the list loads. */
  loading?: boolean;
  loadingCount?: number;
  /** Shown instead of the grid when there are no categories. */
  empty?: React.ReactNode;
}

const GRID_COLUMNS = {
  2: "",
  3: "md:grid-cols-3",
  4: "md:grid-cols-3 lg:grid-cols-4",
  6: "sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6",
} as const;

export function CategoryGrid({
  categories,
  hrefFor,
  renderLink,
  tileProps,
  columns = 4,
  liveLabel,
  viewerLabel,
  loading = false,
  loadingCount = 8,
  empty,
  className,
  ...props
}: CategoryGridProps): React.JSX.Element | null {
  if (!loading && categories.length === 0) return empty ? <>{empty}</> : null;
  return (
    <div className={cn("grid min-w-0 grid-cols-2 gap-3", GRID_COLUMNS[columns], className)} {...props}>
      {loading
        ? Array.from({ length: Math.max(0, loadingCount) }, (_, index) => (
            <div key={index} aria-hidden data-slot="category-tile-skeleton" className="flex min-w-0 flex-col gap-2 p-2">
              <Skeleton className="aspect-3/4 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ))
        : categories.map((category) => (
            <CategoryTile
              key={category.id}
              {...tileProps?.(category)}
              category={category}
              href={hrefFor?.(category)}
              render={renderLink?.(category)}
              liveLabel={liveLabel}
              viewerLabel={viewerLabel}
            />
          ))}
    </div>
  );
}
