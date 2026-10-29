// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime } from "@commonair/ui";
import { Rocket01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { RaidBannerState } from "./state.ts";

/**
 * The outgoing raid's countdown above the chat log (`raid-banner`). When the raid completes the
 * panel follows it to the target's page; the broadcaster stays.
 */
export function RaidBanner({
  raid,
  isBroadcaster,
}: {
  raid: RaidBannerState;
  isBroadcaster: boolean;
}): React.JSX.Element {
  return (
    <div
      data-testid="raid-banner"
      data-raid-id={raid.raidId}
      data-to={raid.to}
      data-execute-at={raid.executeAt}
      className="flex min-w-0 items-start gap-2 border-s-2 border-primary bg-muted px-2 py-1.5 text-xs"
    >
      <HugeiconsIcon
        icon={Rocket01Icon}
        strokeWidth={2}
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-primary"
      />
      <p className="min-w-0 flex-1 break-words">
        {/* Only the name is announced: the countdown changes every second. */}
        <span aria-live="polite" className="font-semibold">
          {t("raid.banner", { name: raid.toDisplayName })}
        </span>{" "}
        <span className="text-muted-foreground">
          {isBroadcaster ? t("raid.leavingBroadcaster") : t("raid.leaving")}{" "}
          <RelativeTime date={raid.executeAt} tooltip={false} />
        </span>
      </p>
    </div>
  );
}
