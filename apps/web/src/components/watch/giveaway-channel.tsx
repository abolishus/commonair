// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The giveaway verify page's way back (D3.9; watch.md WX-12, P9): the channel card on top (name,
 * "Watch live" while live, Follow) and "Back to <channel>" at the end, so the page winners and
 * doubters share is no longer an island. The card is the watch pages' own (`watch-channel-card`).
 */
import { PageContainer } from "@commonair/ui/layouts";
import { Button } from "@commonair/ui/components/button";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { summarize } from "../../lib/channel-summary.ts";
import { useWatchChannel, WatchChannelCard, type ChannelCard } from "./watch-channel-card.tsx";

export const loadChannelCard = async (slug: string): Promise<ChannelCard> => {
  const requestedAt = Date.now();
  const c = summarize(await api().channels.get({ channel: slug }));
  return {
    displayName: c.displayName,
    avatarUrl: c.avatarUrl,
    accent: c.accent,
    followerCount: c.followerCount,
    following: c.following,
    live: c.live ? { viewerCount: c.live.viewerCount } : null,
    requestedAt,
  };
};

export function GiveawayChannelFrame({
  slug,
  signedIn,
  load = loadChannelCard,
  children,
}: {
  slug: string;
  signedIn: boolean;
  load?: (slug: string) => Promise<ChannelCard>;
  children: React.ReactNode;
}): React.JSX.Element {
  const card = useWatchChannel(slug, load);
  const name = card.status === "ok" ? card.card.displayName : slug;
  return (
    <>
      {card.status === "ok" ? (
        <PageContainer className="max-w-3xl pt-8">
          <WatchChannelCard slug={slug} card={card.card} signedIn={signedIn} />
        </PageContainer>
      ) : null}
      {children}
      {card.status === "missing" ? null : (
        <PageContainer className="max-w-3xl pb-8">
          <Button
            data-testid="giveaway-back-to-channel"
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link to="/$channel" params={{ channel: slug }} />}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} aria-hidden className="rtl:rotate-180" />
            {t("watch.notAvailable.back", { name })}
          </Button>
        </PageContainer>
      )}
    </>
  );
}
