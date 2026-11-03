// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel banner on `/$channel` (`channel-banner`, docs/testing/b8-selectors.md). The 6:1
 * frame is the studio's banner ratio (`channel-appearance.tsx`), reserved before the image loads so
 * nothing below it moves. The image is decorative (`alt=""`): the channel's name is the header
 * right under it. The URL is the API's, on our own media origin, used as is.
 */
import { Skeleton } from "@commonair/ui";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import type * as React from "react";

/** The studio's banner frame: 1200 × 200. */
export const BANNER_RATIO = 6;

export function ChannelBanner({ url }: { url: string }): React.JSX.Element {
  return (
    <AspectRatio
      ratio={BANNER_RATIO}
      data-testid="channel-banner"
      data-src={url}
      className="overflow-hidden rounded-md border bg-muted"
    >
      <img src={url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
    </AspectRatio>
  );
}

/** The banner's frame while we do not yet know whether it may show (the 18+ check is loading). */
export function ChannelBannerSkeleton(): React.JSX.Element {
  return (
    <AspectRatio ratio={BANNER_RATIO} aria-hidden className="overflow-hidden rounded-md">
      <Skeleton className="size-full" />
    </AspectRatio>
  );
}
