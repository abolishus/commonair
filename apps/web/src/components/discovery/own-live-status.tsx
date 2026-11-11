// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F7: when the signed-in viewer's own channel is live, home shows this one row instead of their own
 * card in a shelf (discovery's `LiveStatusBar compact`): live state, verified viewers, uptime and
 * the way back to the stream manager.
 */
import type { StreamCard } from "@commonair/contracts/dto";
import { LiveBadge, RelativeTime, ViewerCount } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

export function OwnLiveStatus({ card }: { card: StreamCard }): React.JSX.Element {
  const { broadcast } = card;
  return (
    <section
      aria-label={t("fixWeb.home.ownLive.label")}
      data-testid="home-own-live"
      data-channel={card.channel.slug}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-card px-4 py-3 text-sm ring-1 ring-border"
    >
      <span className="flex items-center gap-2">
        <LiveBadge />
        <span className="font-medium">{t("fixWeb.home.ownLive.title")}</span>
      </span>
      <ViewerCount count={broadcast.viewerCount} />
      <span className="text-muted-foreground tabular-nums">
        <span className="sr-only">{t("fixWeb.home.ownLive.uptime")} </span>
        <RelativeTime date={broadcast.startedAt} mode="elapsed" tooltip={false} />
      </span>
      <span dir="auto" className="min-w-0 flex-1 truncate text-muted-foreground">
        {broadcast.title}
      </span>
      <Button
        data-testid="home-own-live-manager"
        variant="outline"
        size="sm"
        nativeButton={false}
        render={<Link to="/dashboard" />}
      >
        {t("fixWeb.home.ownLive.manager")}
      </Button>
    </section>
  );
}
