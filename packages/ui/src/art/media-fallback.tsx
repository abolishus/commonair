// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "../lib/utils.ts";
import { ChannelAvatar, type Accent } from "../primitives/channel-avatar.tsx";
import { OverlayBadge } from "../primitives/overlay-badge.tsx";
import { Arcs } from "./arcs.tsx";

/**
 * `offline`: a channel that is not live (avatar at the bottom start). `nothumb`: a live stream
 * with no frame yet (avatar centred, so the corner overlays stay free). `vod`: a video or clip
 * without a thumbnail (the field and the arcs only).
 */
export type MediaFallbackKind = "offline" | "nothumb" | "vod";

export interface MediaFallbackProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** Scopes `--channel-accent` to the field; without it the nearest `data-accent` applies. */
  accent?: Accent | null;
  /** The channel's display name, for the avatar's initial. No name, no avatar. */
  name?: string;
  avatarSrc?: string | null;
  kind?: MediaFallbackKind;
  /** Visible overlay text at the top start, e.g. "Offline" (from the caller's catalog). */
  label?: React.ReactNode;
  locale?: string;
}

/**
 * What a tile shows instead of a missing or broken thumbnail: a channel-accent tinted field (18 %
 * over the card in dark, 12 % in light) with the arcs off-centre, never a grey slab. It fills its
 * box, so put it inside the 16:9 frame. The art is hidden from assistive tech; the label is not.
 */
export function MediaFallback({
  accent,
  name,
  avatarSrc,
  kind = "nothumb",
  label,
  locale,
  className,
  ...props
}: MediaFallbackProps): React.JSX.Element {
  const avatar = kind !== "vod" && name;
  return (
    <span
      data-slot="media-fallback"
      data-kind={kind}
      data-accent={accent ?? undefined}
      className={cn("relative block size-full overflow-hidden bg-card", className)}
      {...props}
    >
      <span aria-hidden className="absolute inset-0">
        <span
          data-slot="media-fallback-tint"
          className="absolute inset-0 bg-channel-accent/12 dark:bg-channel-accent/18"
        />
        <Arcs className="absolute -end-1/12 -top-1/5 w-7/10 text-channel-accent opacity-30" />
        {avatar && (
          <span
            className={cn(
              "absolute flex",
              kind === "offline" ? "start-3 bottom-3" : "inset-0 items-center justify-center",
            )}
          >
            <ChannelAvatar
              name={name}
              src={avatarSrc}
              accent={accent}
              size={kind === "offline" ? "md" : "lg"}
              locale={locale}
              decorative
            />
          </span>
        )}
      </span>
      {label && (
        <OverlayBadge data-slot="media-fallback-label" className="absolute start-2 top-2">
          {label}
        </OverlayBadge>
      )}
    </span>
  );
}
