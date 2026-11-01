// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { fillNode } from "../../lib/fill.tsx";
import type { ChannelSummary } from "../../lib/channel-summary.ts";

export interface MovedNoticeProps {
  /** The channel's display name, for the notice text. */
  channelName: string;
  /** `Channel.movedTo`: where the channel moved and when; null when it has not moved. */
  movedTo: ChannelSummary["movedTo"];
}

/**
 * The "moved to …" notice on the channel page (ADR 0037 decision 3): the address the streamer
 * gave, opened in a new tab without a referrer, with the note that it leaves this instance and
 * that subscriptions continue until the streamer ends them (decision (m)).
 */
export function MovedNotice({ channelName, movedTo }: MovedNoticeProps): React.JSX.Element | null {
  if (!movedTo) return null;
  return (
    <AlertCallout
      data-testid="moved-notice"
      data-url={movedTo.url}
      tone="info"
      title={t("portability.notice.title", { channel: channelName })}
      action={
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={
            <a
              href={movedTo.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              aria-label={t("portability.notice.open")}
            />
          }
        >
          {t("portability.notice.open")}
          <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} aria-hidden />
        </Button>
      }
    >
      <p className="break-all">{movedTo.url}</p>
      <p className="text-muted-foreground">
        {t("portability.notice.external")} {t("portability.notice.subscriptions")}{" "}
        {fillNode(t("portability.notice.movedAt"), "time", <RelativeTime date={movedTo.at} />)}
      </p>
    </AlertCallout>
  );
}
