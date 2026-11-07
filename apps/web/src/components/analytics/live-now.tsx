// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The analytics page's "Live now" entry (overhaul decision 2): the live broadcast is not in the
 * settled rollup until it ends, so it shows here with the worker's running peak, marked as
 * provisional. The settled peak in the broadcast list stays the final number.
 */
import type { AnalyticsRange } from "@commonair/contracts/dto";
import { LiveBadge, ViewerCount, formatDateTime, useLocale } from "@commonair/ui";
import { StatCard } from "@commonair/ui/blocks/data";
import * as React from "react";
import { t } from "../../i18n/index.ts";

export type LiveEntry = NonNullable<AnalyticsRange["live"]>;

export function LiveNowEntry({ live }: { live: LiveEntry }): React.JSX.Element {
  const { locale } = useLocale();
  const headingId = React.useId();
  return (
    <section
      data-testid="analytics-live-now"
      data-broadcast={live.broadcastId}
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <LiveBadge />
        <h2 id={headingId} className="text-sm font-medium">
          {t("fixViewers.analytics.live.heading", { time: formatDateTime(new Date(live.startedAt), locale) })}
        </h2>
      </div>
      <p className="min-w-0 truncate text-sm text-muted-foreground">
        {live.title.trim() || t("analytics.broadcast.untitled")}
      </p>
      <StatCard
        size="sm"
        className="max-w-sm"
        data-testid="analytics-live-peak"
        data-value={live.peakSoFar}
        label={t("fixViewers.analytics.live.peak")}
        value={<ViewerCount count={live.peakSoFar} icon={false} />}
        hint={t("fixViewers.analytics.live.body")}
      />
    </section>
  );
}
