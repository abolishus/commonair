// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Add to calendar" (the next stream, one `.ics` download) and "Subscribe in calendar" (the
 * channel's feed on `webcal:`), both first-party (`/api/channels/<slug>/schedule.ics`): no
 * calendar service is involved. Each click is counted (`channel.schedule`, `ics` or `feed`).
 */
import { Button } from "@commonair/ui/components/button";
import { Calendar03Icon, CalendarAdd01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { nextStreamIcsPath, webcalUrl } from "./model.ts";

export function AddToCalendar({ slug }: { slug: string }): React.JSX.Element {
  return (
    <Button
      data-testid="channel-offline-calendar"
      variant="ghost"
      nativeButton={false}
      render={
        <a
          href={nextStreamIcsPath(slug)}
          download={`${slug}.ics`}
          aria-label={t("d3Watch.offline.calendar")}
          onClick={() => trackUi("channel.schedule", "click", "ics")}
        />
      }
    >
      <HugeiconsIcon icon={CalendarAdd01Icon} strokeWidth={2} aria-hidden />
      {t("d3Watch.offline.calendar")}
    </Button>
  );
}

export function SubscribeInCalendar({ slug, publicUrl }: { slug: string; publicUrl: string }): React.JSX.Element {
  return (
    <Button
      data-testid="channel-schedule-subscribe"
      variant="ghost"
      nativeButton={false}
      render={
        <a
          href={webcalUrl(publicUrl, slug)}
          aria-label={t("w5Schedule.card.subscribe")}
          onClick={() => trackUi("channel.schedule", "click", "feed")}
        />
      }
    >
      <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} aria-hidden />
      {t("w5Schedule.card.subscribe")}
    </Button>
  );
}
