// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Button } from "@commonair/ui/components/button";
import { cn } from "@commonair/ui/lib/utils";
import { SkeletonThumbnail } from "../../primitives/skeletons.tsx";

export interface SensitiveMediaProps extends React.ComponentProps<"div"> {
  /** Blurred, grayscale and unreachable (inert) while true. */
  obscured: boolean;
  /** Shown centred over the media while obscured: the notice and its reveal action. */
  overlay?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Media that may be harmful to look at (a flagged frame, a stream under review): blurred and
 * grayscale until the viewer chooses to see it. While obscured the media is `inert`, so its own
 * controls (a player's unmute) cannot be reached by pointer or keyboard. The transition is skipped
 * under `prefers-reduced-motion`.
 */
export function SensitiveMedia({
  obscured,
  overlay,
  children,
  className,
  ...props
}: SensitiveMediaProps): React.JSX.Element {
  return (
    <div
      data-slot="sensitive-media"
      data-obscured={obscured ? "true" : "false"}
      className={cn("relative isolate min-w-0 overflow-hidden", className)}
      {...props}
    >
      <div
        inert={obscured || undefined}
        aria-hidden={obscured || undefined}
        className={cn(
          "motion-safe:transition motion-reduce:transition-none",
          obscured && "pointer-events-none blur-2xl grayscale select-none",
        )}
      >
        {children}
      </div>
      {obscured && overlay ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background/70 p-4 text-center text-sm">
          {overlay}
        </div>
      ) : null}
    </div>
  );
}

type ButtonProps = React.ComponentProps<typeof Button>;

export interface FrameTileProps extends Omit<React.ComponentProps<"figure">, "children"> {
  /** The image (usually a `data:` URL). `null` while it is not loaded: `placeholder` shows instead. */
  src: string | null;
  alt: string;
  /** Blurred and grayscale until true. */
  revealed: boolean;
  onReveal?: () => void;
  revealLabel: string;
  /** Says why the frame is blurred, above the reveal button. */
  notice?: React.ReactNode;
  /** Under the frame: score, provider, capture time. */
  caption?: React.ReactNode;
  /** Shown instead of the image while `src` is null (a skeleton by default, or a "View" action). */
  placeholder?: React.ReactNode;
  revealButtonProps?: Omit<ButtonProps, "onClick" | "children"> & { [key: `data-${string}`]: string | undefined };
}

/**
 * One flagged frame or evidence image for review: blurred and grayscale by default, revealed by
 * an explicit click. The image is never a link and is not draggable.
 */
export function FrameTile({
  src,
  alt,
  revealed,
  onReveal,
  revealLabel,
  notice,
  caption,
  placeholder,
  revealButtonProps,
  className,
  ...props
}: FrameTileProps): React.JSX.Element {
  return (
    <figure data-slot="frame-tile" className={cn("flex min-w-0 flex-col gap-2", className)} {...props}>
      {src === null ? (
        <AspectRatio ratio={16 / 9} className="grid place-items-center overflow-hidden bg-muted">
          {placeholder ?? <SkeletonThumbnail className="absolute inset-0" />}
        </AspectRatio>
      ) : (
        <SensitiveMedia
          obscured={!revealed}
          overlay={
            <>
              {notice ? <p className="text-muted-foreground">{notice}</p> : null}
              <Button type="button" variant="outline" size="sm" onClick={onReveal} {...revealButtonProps}>
                {revealLabel}
              </Button>
            </>
          }
        >
          <AspectRatio ratio={16 / 9} className="bg-muted">
            <img
              src={src}
              alt={revealed ? alt : ""}
              draggable={false}
              referrerPolicy="no-referrer"
              className="absolute inset-0 size-full object-contain"
            />
          </AspectRatio>
        </SensitiveMedia>
      )}
      {caption ? <figcaption className="text-xs text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}
