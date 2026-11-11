// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-money (overhaul D5.6, creator-studio P6): the "What's working" row on `/analytics`. Four
 * tiles, each one sentence from the period's settled numbers, and where a stream is behind the
 * answer, a link that opens it in the broadcast section below.
 */
import type { AnalyticsRange } from "@commonair/contracts/dto";
import { NO_VALUE, formatDuration, formatHour, formatNumber, useLocale } from "@commonair/ui";
import { StatCard, StatGrid } from "@commonair/ui/blocks/data";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { type LocalSlot, averageWatchSeconds, bestSlot, followsPerHour, localSlot, topGrowth } from "./insights.ts";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** The broadcast section's anchor, which each insight's link scrolls to. */
export const BROADCAST_ANCHOR = "analytics-broadcast";

export interface InsightTilesProps {
  range: AnalyticsRange;
  period: { from: string; to: string };
  /** Follow times; null when the follower list is not complete (those insights then say so). */
  followedAt: readonly string[] | null;
  /** Opens a broadcast in the section below. */
  onOpen: (broadcastId: string) => void;
  /** Day and hour of an instant; the viewer's own zone unless a test pins it. */
  slot?: LocalSlot;
}

export function InsightTiles({
  range,
  period,
  followedAt,
  onOpen,
  slot = localSlot,
}: InsightTilesProps): React.JSX.Element {
  const { locale } = useLocale();
  const best = bestSlot(range.broadcasts, slot);
  const watch = averageWatchSeconds(range.totals);
  const perHour = followsPerHour(range.broadcasts, followedAt, period);
  const growth = topGrowth(range.broadcasts, followedAt);
  const open = (id: string) => (
    <Button
      data-testid="analytics-insight-open"
      data-broadcast-id={id}
      variant="link"
      size="sm"
      className="h-auto self-start p-0"
      nativeButton={false}
      render={<a href={`#${BROADCAST_ANCHOR}`} aria-label={t("d5Money.insights.open")} />}
      onClick={() => onOpen(id)}
    >
      {t("d5Money.insights.open")}
    </Button>
  );
  return (
    <Section heading={t("d5Money.insights.heading")} description={t("d5Money.insights.hint")}>
      <StatGrid cols={4} data-testid="analytics-insights">
        <StatCard
          size="sm"
          data-testid="analytics-insight"
          data-insight="best-slot"
          data-ready={String(best !== null)}
          label={t("d5Money.insights.bestSlot")}
          value={
            best
              ? t("d5Money.insights.bestSlotValue", {
                  weekday: WEEKDAYS[best.weekday] ?? "other",
                  hour: formatHour(best.hour, locale),
                })
              : NO_VALUE
          }
          hint={
            best
              ? t("d5Money.insights.bestSlotHint", { viewers: formatNumber(Math.round(best.averageViewers), locale) })
              : t("d5Money.insights.bestSlotNone")
          }
          footer={best ? open(best.broadcastId) : undefined}
        />
        <StatCard
          size="sm"
          data-testid="analytics-insight"
          data-insight="average-watch"
          data-ready={String(watch !== null)}
          label={t("d5Money.insights.avgWatch")}
          value={watch !== null ? formatDuration(watch) : NO_VALUE}
          hint={watch !== null ? t("d5Money.insights.avgWatchHint") : t("d5Money.insights.avgWatchNone")}
        />
        <StatCard
          size="sm"
          data-testid="analytics-insight"
          data-insight="follows-per-hour"
          data-ready={String(perHour !== null)}
          label={t("d5Money.insights.followsPerHour")}
          value={perHour !== null ? formatNumber(perHour, locale) : NO_VALUE}
          hint={perHour !== null ? t("d5Money.insights.followsPerHourHint") : t("d5Money.insights.followsNone")}
        />
        <StatCard
          size="sm"
          data-testid="analytics-insight"
          data-insight="top-growth"
          data-ready={String(growth !== null)}
          label={t("d5Money.insights.topGrowth")}
          value={growth ? growth.title.trim() || t("analytics.broadcast.untitled") : NO_VALUE}
          hint={
            growth
              ? t("d5Money.insights.topGrowthHint", { count: growth.follows })
              : followedAt === null
                ? t("d5Money.insights.followsNone")
                : t("d5Money.insights.topGrowthNone")
          }
          footer={growth ? open(growth.broadcastId) : undefined}
        />
      </StatGrid>
    </Section>
  );
}
