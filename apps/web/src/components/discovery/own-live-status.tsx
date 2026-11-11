// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F7: when the signed-in viewer's own channel is live, home shows this one row instead of their own
 * card in a shelf: the studio's LiveStatusBar in its compact form (D5.2), with live state, verified
 * viewers, uptime and the way back to the stream manager.
 */
import type { StreamCard } from "@commonair/contracts/dto";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { CompactLiveStatusBar } from "../studio-shell/live-status.tsx";

export function OwnLiveStatus({ card }: { card: StreamCard }): React.JSX.Element {
  return (
    <CompactLiveStatusBar
      data-testid="home-own-live"
      data-channel={card.channel.slug}
      card={card}
      region={t("fixWeb.home.ownLive.label")}
      title={t("fixWeb.home.ownLive.title")}
      manager={t("fixWeb.home.ownLive.manager")}
    />
  );
}
