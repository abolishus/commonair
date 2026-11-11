// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The embed's identity and way home (D3.9; watch.md WX-10, P7): the channel's name over the
 * picture's top-left corner and "Watch on <site>" at the top-right, a plain link that opens the
 * channel in a new tab (no script, nothing third-party). Offline, the embed says so with the same
 * link, so a dead embed still leads somewhere.
 */
import { ChannelAvatar, EmptyState, OverlayBadge, type Accent } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { LinkSquare02Icon, Tv01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

export interface EmbedChannel {
  slug: string;
  displayName: string;
  avatarUrl: string | null;
  accent?: Accent | null;
}

/** The channel page the embed links to (the iframe's own origin is the instance's). */
export const embedChannelHref = (slug: string) => `/${encodeURIComponent(slug)}`;

export function EmbedIdentity({ channel }: { channel: EmbedChannel }): React.JSX.Element {
  return (
    <OverlayBadge data-testid="embed-identity" className="flex max-w-56 min-w-0 items-center gap-2">
      <ChannelAvatar
        name={channel.displayName}
        src={channel.avatarUrl}
        accent={channel.accent ?? null}
        size="xs"
        decorative
      />
      <span className="min-w-0 truncate">{channel.displayName}</span>
    </OverlayBadge>
  );
}

export function EmbedWatchOn({ channel, site }: { channel: EmbedChannel; site: string }): React.JSX.Element {
  return (
    <a
      data-testid="embed-watch-on"
      href={embedChannelHref(channel.slug)}
      target="_blank"
      rel="noopener"
      aria-label={t("d3Watch.embed.watchOnLabel", { name: channel.displayName, site })}
      className="pointer-events-auto inline-flex min-h-6 items-center gap-1 bg-overlay/80 px-2 text-xs font-medium text-overlay-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {t("d3Watch.embed.watchOn", { site })}
      <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} aria-hidden className="size-3" />
    </a>
  );
}

export function EmbedOffline({ channel, site }: { channel: EmbedChannel; site: string }): React.JSX.Element {
  return (
    <EmptyState
      data-testid="offline-state"
      icon={Tv01Icon}
      title={t("channel.offline", { name: channel.displayName })}
      action={
        <Button
          data-testid="embed-watch-on"
          variant="outline"
          size="sm"
          nativeButton={false}
          render={
            <a
              href={embedChannelHref(channel.slug)}
              target="_blank"
              rel="noopener"
              aria-label={t("d3Watch.embed.watchOnLabel", { name: channel.displayName, site })}
            />
          }
        >
          {t("d3Watch.embed.watchOn", { site })}
          <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} aria-hidden />
        </Button>
      }
    />
  );
}
