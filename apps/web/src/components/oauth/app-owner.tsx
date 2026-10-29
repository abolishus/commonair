// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChannelAvatar } from "@commonair/ui";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { fillNode } from "../../lib/fill.tsx";
import type { AppSummaryDto } from "./shared.ts";

/**
 * Who registered the app (`oauth-consent-owner`), linked to their profile: a channel's slug is its
 * owner's username. A plain link, so the consent card renders outside the router too.
 */
export function AppOwner({
  owner,
  testId = "oauth-consent-owner",
}: {
  owner: AppSummaryDto["owner"];
  testId?: string;
}): React.JSX.Element {
  return (
    <p data-testid={testId} data-username={owner.username} className="flex items-center gap-2 text-sm">
      <ChannelAvatar name={owner.username} size="xs" decorative />
      <span className="min-w-0 break-words text-muted-foreground">
        {fillNode(
          t("oauth.owner.by"),
          "username",
          <a
            href={`/${encodeURIComponent(owner.username)}`}
            aria-label={t("oauth.owner.profile", { username: owner.username })}
            className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
          >
            {owner.username}
          </a>,
        )}
      </span>
    </p>
  );
}
