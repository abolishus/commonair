// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The About tab's schedule (overhaul wave 5): the weekly streams in the viewer's own time zone,
 * the one-offs coming up, and "Subscribe in calendar". It loads `channels.schedule.get` when it
 * mounts, which is only when About is opened on a channel with a next stream.
 */
import { formatDateTime, SkeletonText, useLocale } from "@commonair/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { SubscribeInCalendar } from "./calendar-links.tsx";
import { upcomingOneOffs, weekdayKey, weeklyRows, type ChannelSchedule } from "./model.ts";

/** About's tab context: the About tab sets it, so the schedule loads there and not on Home. */
export const AboutTabContext = React.createContext(false);

export function AboutSchedule({
  channel,
  publicUrl,
  load: loadProp,
}: {
  channel: string;
  publicUrl: string;
  /** Tests pass a fake; the API otherwise. */
  load?: (channel: string) => Promise<ChannelSchedule>;
}): React.JSX.Element | null {
  const { locale, timeZone } = useLocale();
  const load = useRetryingLoad(`about-schedule:${channel}`, () =>
    loadProp ? loadProp(channel) : api().channels.schedule.get({ channel }),
  );
  const headingId = React.useId();
  if (load.state === "failed")
    return (
      <SectionLoadError
        section={t("w5Schedule.about.title")}
        load={load}
        headingLevel={3}
        data-testid="channel-schedule-error"
        retryTestId="channel-schedule-retry"
      />
    );
  const schedule = load.data;
  const rows = schedule ? weeklyRows(schedule) : [];
  const oneOffs = schedule ? upcomingOneOffs(schedule) : [];
  if (schedule && rows.length === 0 && oneOffs.length === 0) return null;
  return (
    <Card
      data-testid="channel-schedule"
      size="sm"
      className="min-w-0"
      aria-labelledby={headingId}
      aria-busy={!schedule}
    >
      <CardHeader>
        <CardTitle>
          <h3 id={headingId} className="text-base font-semibold">
            {t("w5Schedule.about.title")}
          </h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {!schedule ? (
          <SkeletonText lines={3} />
        ) : (
          <>
            {rows.length > 0 ? (
              <ul className="flex min-w-0 flex-col gap-2">
                {rows.map((row) => (
                  <li
                    key={row.slotId}
                    data-testid="channel-schedule-slot"
                    data-weekday={row.weekday}
                    className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm"
                  >
                    <span className="font-medium tabular-nums">
                      {t("w5Schedule.about.slot", {
                        weekday: t(weekdayKey(row.weekday)),
                        start: row.start,
                        end: row.end,
                      })}
                    </span>
                    {row.title ? <span className="min-w-0 break-words">{row.title}</span> : null}
                    {row.category ? <span className="text-muted-foreground">{row.category.name}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {oneOffs.length > 0 ? (
              <div className="flex min-w-0 flex-col gap-1">
                <h4 className="text-sm font-medium">{t("w5Schedule.about.oneOffs")}</h4>
                <ul className="flex min-w-0 flex-col gap-1">
                  {oneOffs.map((o) => (
                    <li
                      key={o.oneOffId ?? o.startsAt}
                      data-testid="channel-schedule-one-off"
                      className="text-sm break-words"
                    >
                      <time dateTime={o.startsAt}>{formatDateTime(new Date(o.startsAt), locale, timeZone)}</time>
                      {o.title ? ` · ${o.title}` : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-sm text-muted-foreground">{t("w5Schedule.about.yourTime")}</p>
            <div className="flex min-w-0 flex-col items-start gap-1">
              <SubscribeInCalendar slug={channel} publicUrl={publicUrl} />
              <p className="text-sm text-muted-foreground">{t("w5Schedule.card.subscribeHint")}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
