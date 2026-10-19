// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChannelCard } from "@commonair/contracts/dto";
import { ChannelAvatar, EmptyState, RelativeTime } from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { StreamGrid } from "@commonair/ui/blocks/media";
import { Card } from "@commonair/ui/components/card";
import { AlertCircleIcon, LiveStreaming02Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../i18n/index.ts";
import type {
  DirectorySection,
  DirectorySectionId,
  OfflineSection,
  OfflineSectionId,
} from "../lib/directory-sections.ts";

function sectionTitle(id: DirectorySectionId): string {
  switch (id) {
    case "spotlight":
      return t("directory.section.spotlight");
    case "new":
      return t("directory.section.new");
    case "live":
      return t("directory.section.live");
    case "following":
      return t("directory.section.following");
  }
}

function offlineTitle(id: OfflineSectionId): string {
  switch (id) {
    case "following-offline":
      return t("directory.section.followingOffline");
    case "recent":
      return t("directory.section.recent");
  }
}

/**
 * The directory on `/`: one `StreamGrid` per non-empty live section, then the offline sections.
 * `sections` is null when loading failed.
 */
export function Directory({
  sections,
  offline = [],
}: {
  sections: DirectorySection[] | null;
  offline?: OfflineSection[];
}): React.JSX.Element {
  return (
    <div data-testid="directory" className="flex flex-col gap-8">
      {sections === null ? (
        <EmptyState icon={AlertCircleIcon} title={t("directory.loadFailed")} />
      ) : sections.length === 0 ? (
        <EmptyState
          data-testid="directory-empty"
          icon={LiveStreaming02Icon}
          title={t("directory.empty")}
          description={t("directory.emptyHint")}
        />
      ) : (
        sections.map((section) => (
          <Section
            key={section.id}
            data-testid="directory-section"
            data-section={section.id}
            heading={sectionTitle(section.id)}
          >
            <StreamGrid
              streams={section.cards}
              hrefFor={(card) => `/${card.channel.slug}`}
              renderLink={(card) => <Link to="/$channel" params={{ channel: card.channel.slug }} />}
              cardProps={(card) => ({
                "data-testid": "stream-card",
                "data-channel": card.channel.slug,
                showReason: section.id !== "following",
              })}
            />
          </Section>
        ))
      )}
      {sections !== null &&
        offline.map((section) => (
          <Section
            key={section.id}
            data-testid="directory-section"
            data-section={section.id}
            heading={offlineTitle(section.id)}
          >
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {section.cards.map((card) => (
                <OfflineChannelCard key={card.channel.id} card={card} />
              ))}
            </div>
          </Section>
        ))}
    </div>
  );
}

/** An offline channel: avatar, name, last title and when it was last live. */
function OfflineChannelCard({ card }: { card: ChannelCard }): React.JSX.Element {
  return (
    <Link
      to="/$channel"
      params={{ channel: card.channel.slug }}
      data-testid="channel-card"
      data-channel={card.channel.slug}
      className="group block min-w-0 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="flex min-w-0 flex-row items-center gap-3 p-3 transition-colors group-hover:bg-muted">
        <ChannelAvatar
          name={card.channel.displayName}
          src={card.channel.avatarUrl}
          accent={card.channel.accent}
          decorative
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{card.channel.displayName}</span>
          {card.title && <span className="truncate text-xs text-muted-foreground">{card.title}</span>}
          <span className="truncate text-xs text-muted-foreground">
            {card.lastLiveAt ? (
              <>
                {t("directory.lastLive")} <RelativeTime date={card.lastLiveAt} tooltip={false} />
              </>
            ) : (
              t("directory.neverLive")
            )}
            {card.category && ` · ${card.category.name}`}
          </span>
        </span>
      </Card>
    </Link>
  );
}
