// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
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
import { cn } from "../lib/utils.ts";
import type { Accent } from "../primitives/channel-avatar.tsx";
import { artHash } from "./hash.ts";
import { SignalBars } from "./signal-bars.tsx";

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
 * Text-safe chart tokens in both themes (globals.css: chart-1..6 pass 4.5:1 on the light
 * background; chart-7 is graphics-only). The tint is 12 % in light and 22 % in dark, so the
 * dark field is not muddy. Full class strings so Tailwind sees them.
 */
const TONES = [
  { text: "text-chart-1", tint: "bg-chart-1/12 dark:bg-chart-1/22" },
  { text: "text-chart-2", tint: "bg-chart-2/12 dark:bg-chart-2/22" },
  { text: "text-chart-3", tint: "bg-chart-3/12 dark:bg-chart-3/22" },
  { text: "text-chart-4", tint: "bg-chart-4/12 dark:bg-chart-4/22" },
  { text: "text-chart-5", tint: "bg-chart-5/12 dark:bg-chart-5/22" },
  { text: "text-chart-6", tint: "bg-chart-6/12 dark:bg-chart-6/22" },
] as const;
const ACCENT_TONE = { text: "text-channel-accent", tint: "bg-channel-accent/12 dark:bg-channel-accent/22" } as const;

/** By word prefix, so "starfall" is not "art": the first kind with a matching word wins. */
export function categoryKind(slugOrName: string): CategoryKind {
  const tokens = slugOrName.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  for (const [kind, words] of KIND_WORDS) if (tokens.some((tok) => words.some((w) => tok.startsWith(w)))) return kind;
  return "other";
}

/** The generated tile for a category without box art: the same tone and glyph for the same slug, always. */
export function categoryFallback(slug: string): { tone: number; kind: CategoryKind } {
  return { tone: artHash(slug) % TONES.length, kind: categoryKind(slug) };
}

export type CategoryArtShape = "portrait" | "landscape";

export interface CategoryArtProps extends Omit<React.ComponentProps<"span">, "children"> {
  slug: string;
  imageUrl?: string | null;
  /** A channel accent for the fallback; without one the fallback picks a chart token from the slug. */
  accent?: Accent;
  /** Glyph size; the art itself fills its box. */
  iconSize?: "sm" | "md" | "lg";
  /**
   * `portrait` (3:4, the directory tile) or `landscape` (16:9, the compact home shelf) sets the
   * box's own aspect ratio and full width. Leave it out to fill a box the caller sizes.
   */
  shape?: CategoryArtShape;
  /** Nothing live: desaturated to `--muted`, the bars faded. The caller shows no "0 live" badge. */
  muted?: boolean;
}

const SHAPES: Record<CategoryArtShape, string> = { portrait: "aspect-3/4 w-full", landscape: "aspect-video w-full" };
const ICONS = { sm: "size-4", md: "size-6", lg: "size-10" } as const;

/**
 * Box art, or the generated token-coloured tile: a tint, the glyph for the category's kind and
 * the signal-bars strip on the bottom edge (F10). Drawn as the tile's media directly, never as a
 * card inside a card.
 */
export function CategoryArt({
  slug,
  imageUrl,
  accent,
  iconSize = "md",
  shape,
  muted = false,
  className,
  ...props
}: CategoryArtProps): React.JSX.Element {
  const box = shape ? SHAPES[shape] : "size-full";
  if (imageUrl)
    return (
      <span
        data-slot="category-art"
        data-shape={shape}
        data-muted={muted || undefined}
        className={cn("block overflow-hidden", box, className)}
        {...props}
      >
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className={cn("size-full object-cover", muted && "opacity-70 grayscale")}
        />
      </span>
    );
  const { tone, kind } = categoryFallback(slug);
  const colors = accent ? ACCENT_TONE : (TONES[tone] ?? ACCENT_TONE);
  return (
    <span
      data-slot="category-art"
      data-fallback={kind}
      data-tone={accent ? undefined : tone}
      data-accent={accent}
      data-shape={shape}
      data-muted={muted || undefined}
      aria-hidden
      className={cn(
        "relative grid place-items-center overflow-hidden",
        box,
        muted ? "bg-muted text-muted-foreground" : cn("bg-card", colors.text),
        className,
      )}
      {...props}
    >
      {!muted && <span data-slot="category-art-tint" className={cn("absolute inset-0", colors.tint)} />}
      <HugeiconsIcon
        icon={KIND_ICONS[kind]}
        strokeWidth={1.5}
        aria-hidden
        className={cn("relative", ICONS[iconSize])}
      />
      <SignalBars
        variant="band"
        seed={slug}
        className={cn("absolute inset-x-0 bottom-0 h-1", muted && "opacity-35 grayscale")}
      />
    </span>
  );
}
