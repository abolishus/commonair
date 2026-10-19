// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { cn } from "@commonair/ui/lib/utils";

export interface EmoteTileData {
  id: string;
  label: string;
  glyph: string;
  accent?: string;
}

export interface EmoteTileProps extends React.ComponentProps<"figure"> {
  emote: EmoteTileData;
}

export function EmoteTile({ emote, className, ...props }: EmoteTileProps): React.JSX.Element {
  return (
    <figure
      aria-label={emote.label}
      data-accent={emote.accent ?? "zinc"}
      className={cn("min-w-0 bg-channel-accent/10 p-2 text-channel-accent-foreground", className)}
      {...props}
    >
      <AspectRatio ratio={1} className="grid place-items-center text-xl font-semibold">
        {emote.glyph}
      </AspectRatio>
      <figcaption className="truncate text-center text-2xs">{emote.label}</figcaption>
    </figure>
  );
}

export interface EmoteGridProps extends React.ComponentProps<"section"> {
  emotes: EmoteTileData[];
  uploadAction?: React.ReactNode;
  uploadLabel?: string;
  columns?: 4 | 6 | 8;
}

export function EmoteGrid({
  emotes,
  uploadAction,
  uploadLabel,
  columns = 6,
  className,
  ...props
}: EmoteGridProps): React.JSX.Element {
  return (
    <section data-slot="emote-grid" className={cn("flex min-w-0 flex-col gap-3", className)} {...props}>
      {uploadAction && (
        <div className="flex justify-end">
          {uploadLabel && <span className="sr-only">{uploadLabel}</span>}
          {uploadAction}
        </div>
      )}
      <div
        className={cn(
          "grid min-w-0 grid-cols-4 gap-2",
          columns >= 6 && "sm:grid-cols-6",
          columns === 8 && "lg:grid-cols-8",
        )}
      >
        {emotes.map((emote) => (
          <EmoteTile key={emote.id} emote={emote} />
        ))}
      </div>
    </section>
  );
}
