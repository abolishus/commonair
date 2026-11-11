// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio's co-op card on `/dashboard` (overhaul wave 4, D6.4; coop-trust P6 "Studio",
 * creator-studio P2), below the live work: whether the streamer is a member-owner (an icon and a
 * word, never colour alone), the hours toward the streamer class's rule, a creator council rank
 * if they hold one, and links to `/coop` and `/coop/membership`. Neutral styling: no brand fill.
 * The one-time "You're a member-owner" notice belongs to the stream recap, not here.
 */
import { SkeletonText, StatusBadge, formatNumber, useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Progress } from "@commonair/ui/components/progress";
import { Alert02Icon, CheckmarkCircle02Icon, Clock01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import type { CouncilDto, MembershipViewDto } from "../../lib/coop.ts";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { trackUi } from "../../lib/ui-metrics.ts";
import type { SettingLike } from "../creators/facts.ts";
import { type CoopCardStatus, type StreamerProgress, coopCardFacts } from "./model.ts";

/** What the card reads; the real API by default, a fake in tests. */
export interface CoopCardClient {
  membership(): Promise<MembershipViewDto>;
  council(): Promise<CouncilDto>;
  settings(): Promise<readonly SettingLike[]>;
}

export const apiCoopCardClient: CoopCardClient = {
  membership: () => api().coop.membership(),
  council: () => api().coop.council(),
  settings: () => api().coop.settings(),
};

const STATUS = {
  member: { key: "d6Studio.coop.status.member", icon: CheckmarkCircle02Icon, tone: "success" },
  lapsed: { key: "d6Studio.coop.status.lapsed", icon: Alert02Icon, tone: "warning" },
  notYet: { key: "d6Studio.coop.status.notYet", icon: Clock01Icon, tone: "neutral" },
} as const satisfies Record<CoopCardStatus, unknown>;

export interface StudioCoopCardProps {
  userId: string;
  client?: CoopCardClient;
}

export function StudioCoopCard({ userId, client = apiCoopCardClient }: StudioCoopCardProps): React.JSX.Element {
  const { locale } = useLocale();
  const membership = useRetryingLoad("studio-coop|membership", () => client.membership());
  // The council and the rules only add lines; the card stands without them.
  const council = useRetryingLoad("studio-coop|council", () => client.council().catch(() => null));
  const settings = useRetryingLoad("studio-coop|settings", () => client.settings().catch(() => null));

  React.useEffect(() => {
    trackUi("studio.coopCard", "view");
  }, []);

  const title = t("d6Studio.coop.title");
  if (!membership.data) {
    if (membership.state === "failed")
      return (
        <SectionLoadError
          section={title}
          load={membership}
          headingLevel={2}
          data-testid="studio-coop-card-error"
          retryTestId="studio-coop-card-retry"
        />
      );
    return (
      <Card data-testid="studio-coop-card-loading" aria-busy="true" aria-label={t("d6Studio.coop.loading")}>
        <CardContent>
          <SkeletonText lines={3} />
        </CardContent>
      </Card>
    );
  }

  const facts = coopCardFacts(membership.data, council.data, settings.data, userId);
  const status = STATUS[facts.status];
  return (
    <Card data-testid="studio-coop-card" data-status={facts.status}>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>
          {facts.status === "member" ? t("d6Studio.coop.memberIntro") : t("d6Studio.coop.intro")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge data-testid="studio-coop-status" tone={status.tone} icon={status.icon}>
            {t(status.key)}
          </StatusBadge>
          {facts.councilRank !== null ? (
            <span data-testid="studio-coop-council" className="inline-flex items-center gap-1.5 text-sm">
              <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} aria-hidden className="size-4" />
              {t("d6Studio.coop.council", { rank: formatNumber(facts.councilRank, locale) })}
            </span>
          ) : null}
        </div>
        {facts.progress ? <HoursProgress progress={facts.progress} member={facts.status === "member"} /> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          data-testid="studio-coop-membership"
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/coop/membership" />}
        >
          {t("d6Studio.coop.membershipLink")}
        </Button>
        <Button
          data-testid="studio-coop-about"
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link to="/coop" />}
        >
          {t("d6Studio.coop.aboutLink")}
        </Button>
      </CardFooter>
    </Card>
  );
}

function HoursProgress({ progress, member }: { progress: StreamerProgress; member: boolean }): React.JSX.Element {
  const { locale } = useLocale();
  // Tenths of an hour, rounded down, so "10 of 10" never shows before the rule is met.
  const have = formatNumber(Math.floor(progress.have * 10) / 10, locale);
  const need = progress.need;
  const text =
    progress.windowDays === null
      ? t("d6Studio.coop.progressNoWindow", { have, need })
      : t("d6Studio.coop.progress", { have, need, days: progress.windowDays });
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p data-testid="studio-coop-progress" className="text-sm tabular-nums">
        {text}
      </p>
      <Progress value={progress.percent} aria-label={t("d6Studio.coop.progressLabel")} />
      <p className="text-sm text-muted-foreground">
        {member ? t("d6Studio.coop.keepHint") : t("d6Studio.coop.joinHint")}
      </p>
    </div>
  );
}
