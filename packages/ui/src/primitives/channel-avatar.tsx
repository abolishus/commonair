// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { ACCENTS } from "@commonair/contracts/shapes";
import { Avatar, AvatarFallback, AvatarImage } from "../components/avatar.tsx";
import { getInitial } from "../lib/format.ts";
import { useResolvedLocale } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";
import { avatarSizes, type AvatarSize } from "./skeletons.tsx";

export type Accent = (typeof ACCENTS)[number];

const initialSizes: Record<AvatarSize, string> = {
  xs: "text-2xs",
  sm: "text-xs",
  md: "text-sm",
  lg: "text-xl",
  xl: "text-3xl",
};

export interface ChannelAvatarProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** Display name: the accessible name and the source of the fallback initial. */
  name: string;
  /** `avatarUrl` from the DTO; `null`/missing shows the initial. */
  src?: string | null;
  accent?: Accent | null;
  size?: AvatarSize;
  /** Draws the live ring. Pair with a `<LiveBadge>` where the state must also be announced. */
  live?: boolean;
  locale?: string;
  /** The name is already shown next to the avatar: hide it from assistive tech to avoid repeating it. */
  decorative?: boolean;
}

/** User/channel avatar with an accent-colored initial fallback. Use instead of `<img>` or a raw `Avatar`. */
export function ChannelAvatar({
  name,
  src,
  accent,
  size = "md",
  live = false,
  locale,
  decorative = false,
  className,
  ...props
}: ChannelAvatarProps): React.JSX.Element {
  const resolved = useResolvedLocale(locale);
  return (
    <Avatar
      aria-hidden={decorative || undefined}
      data-accent={accent ?? "zinc"}
      data-live={live || undefined}
      className={cn(avatarSizes[size], live && "ring-2 ring-live ring-offset-2 ring-offset-background", className)}
      {...props}
    >
      {src ? <AvatarImage src={src} alt={decorative ? "" : name} loading="lazy" decoding="async" /> : null}
      <AvatarFallback
        className={cn("bg-channel-accent font-medium text-channel-accent-foreground", initialSizes[size])}
      >
        <span aria-hidden>{getInitial(name, resolved)}</span>
        {!decorative && <span className="sr-only">{name}</span>}
      </AvatarFallback>
    </Avatar>
  );
}
