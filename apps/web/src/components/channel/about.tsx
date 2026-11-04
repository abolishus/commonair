// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The About tab (F2; `channel-about`): the banner on top (when the page did not already show it),
 * the bio and follower count, the category and tags, then B8-web's panels as they are. The bio is
 * plain text with its line breaks kept, never parsed. Social links live in panels today (the API
 * has no separate field).
 */
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { ChannelAbout } from "./channel-data.ts";
import { CategoryLink } from "./channel-meta.tsx";
import { ChannelPanels } from "./panels.tsx";
import type { ChannelPanelView } from "./panels-data.ts";

export function ChannelAboutSection({
  name,
  about,
  followers,
  panels,
  banner,
}: {
  name: string;
  about: ChannelAbout;
  /** `<FollowerCount>`. */
  followers: React.ReactNode;
  /** Already filtered (none on a suspended channel). */
  panels: readonly ChannelPanelView[];
  /** The banner, or its pending frame, or null. */
  banner?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div data-testid="channel-about" className="flex min-w-0 flex-col gap-6">
      {banner}
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold break-words">{t("channel.tabs.aboutHeading", { name })}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <p className="text-sm text-muted-foreground">{followers}</p>
          {about.bio !== "" ? (
            <p data-testid="channel-about-bio" className="text-sm break-words whitespace-pre-line">
              {about.bio}
            </p>
          ) : (
            <p data-testid="channel-about-bio-empty" className="text-sm text-muted-foreground">
              {t("channel.tabs.noBio", { name })}
            </p>
          )}
          {about.category ? (
            <p className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
              <span>{t("channel.tabs.streamsIn")}</span>
              <CategoryLink category={about.category} />
            </p>
          ) : null}
        </CardContent>
      </Card>
      <ChannelPanels panels={panels} />
    </div>
  );
}
