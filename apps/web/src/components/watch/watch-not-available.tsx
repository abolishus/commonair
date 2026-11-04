// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A VOD or clip the visitor may not watch (F11, F13; `watch-not-found`): D4's `NotFoundState`, with
 * "Back to <channel>" as the way out. It never says why (missing, private and removed read alike).
 * When the channel itself does not exist, the way out is D4's "Browse live channels".
 */
import { Button } from "@commonair/ui/components/button";
import { Tv01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { NotFoundState } from "../not-found.tsx";
import type { ChannelCardState } from "./watch-channel-card.tsx";

export function WatchNotAvailable({ slug, channel }: { slug: string; channel: ChannelCardState }): React.JSX.Element {
  const name = channel.status === "ok" ? channel.card.displayName : slug;
  return (
    <NotFoundState
      data-testid="watch-not-found"
      icon={Tv01Icon}
      title={t("replay.watch.notFound")}
      description={t("watch.notAvailable.description")}
      {...(channel.status === "missing"
        ? {}
        : {
            action: (
              <Button
                data-testid="empty-state-action"
                nativeButton={false}
                render={<Link to="/$channel" params={{ channel: slug }} />}
              >
                {t("watch.notAvailable.back", { name })}
              </Button>
            ),
          })}
    />
  );
}
