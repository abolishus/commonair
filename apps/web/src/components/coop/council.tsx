// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, Skeleton, SkeletonGroup } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, ResponsiveGrid, SplitLayout } from "@commonair/ui/layouts";
import { Calendar03Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { BoardSeatDto, CouncilDto, ElectionDto, MemberClass, SettingDto } from "../../lib/coop.ts";
import { BoardSeats, CouncilSeats, SeatingExplainer } from "../governance/council.tsx";
import { electionsInOrder, hasOpenElection } from "../governance/model.ts";
import { GovernanceSettingsGroups } from "../governance/settings-groups.tsx";
import { ElectionItem, type ElectionActions } from "./elections.tsx";
import { CoopTabs } from "./nav.tsx";

function Loading(): React.JSX.Element {
  return (
    <SkeletonGroup label={t("coop.loading")}>
      <Skeleton className="h-32 w-full" />
    </SkeletonGroup>
  );
}

export interface CouncilPageProps extends Partial<ElectionActions> {
  council: CouncilDto | null;
  board: BoardSeatDto[] | null;
  elections: ElectionDto[] | null;
  /** The signed-in caller (null: elections are read-only). */
  meId?: string | null;
  /** The caller's active membership classes (who may stand and vote); null while unknown. */
  classes?: readonly MemberClass[] | null;
  /** Shown above the elections when the caller's membership failed to load. */
  membershipError?: React.ReactNode;
  /** Shown in place of a section's content when its load failed (F3); `method` comes from the council load. */
  sectionErrors?: Partial<Record<CouncilSection, React.ReactNode>>;
}

/** The council page's sections that load on their own. */
export type CouncilSection = "council" | "method" | "board" | "elections";

/** Only reachable signed in, where the route passes the real actions. */
const refuse = async (): Promise<void> => {
  throw new Error("signed out");
};

/**
 * `/coop/council` (overhaul D6.3, CT-8): board elections first while one is open or nominating,
 * then the council as people (avatar tiles linked to their channels, a contribution share instead
 * of a raw score), "How seating works" in sentences, and the board.
 */
export function CouncilPage({
  council,
  board,
  elections,
  meId = null,
  classes = [],
  membershipError = null,
  sectionErrors = {},
  onNominate = refuse,
  onVote = refuse,
}: CouncilPageProps): React.JSX.Element {
  const open = hasOpenElection(elections);
  const electionsSection = (
    <Section
      data-testid="council-elections"
      data-open={String(open)}
      heading={t("coop.elections.title")}
      description={t("coop.elections.intro")}
    >
      {membershipError}
      {elections === null ? (
        (sectionErrors.elections ?? <Loading />)
      ) : elections.length === 0 ? (
        // F25: nobody on this page can schedule one (the board does), so no action.
        <EmptyState
          data-testid="council-elections-empty"
          icon={Calendar03Icon}
          headingLevel={3}
          title={t("coop.elections.empty")}
          description={t("settings.coop.electionsEmptyHint")}
        />
      ) : (
        <ResponsiveGrid cols={2}>
          {electionsInOrder(elections).map((e) => (
            <ElectionItem
              key={e.id}
              election={e}
              meId={meId}
              classes={classes}
              onNominate={onNominate}
              onVote={onVote}
            />
          ))}
        </ResponsiveGrid>
      )}
    </Section>
  );
  return (
    <PageContainer
      data-testid="council"
      data-term-id={council?.termId ?? ""}
      data-starts-at={council?.startsAt ?? ""}
      data-ends-at={council?.endsAt ?? ""}
      width="wide"
      className="flex flex-col gap-6 py-8"
    >
      <PageHeader
        title={t("coop.councilPage.title")}
        description={t("coop.councilPage.intro")}
        tabs={<CoopTabs current="council" />}
      />
      {open ? electionsSection : null}
      <SplitLayout
        asideWidth="lg"
        main={
          <div className="flex flex-col gap-6">
            <Section heading={t("coop.council.title")}>
              {council === null ? (
                (sectionErrors.council ?? <Loading />)
              ) : council.members.length === 0 ? (
                <EmptyState
                  icon={UserGroupIcon}
                  headingLevel={3}
                  title={t("coop.council.emptyTitle")}
                  description={t("coop.council.emptyHint")}
                />
              ) : (
                <CouncilSeats council={council} />
              )}
              {council?.endsAt ? (
                <p className="text-sm text-muted-foreground">
                  {t("coop.council.termEnds")} <RelativeTime date={council.endsAt} />
                </p>
              ) : null}
            </Section>
            {open ? null : electionsSection}
          </div>
        }
        aside={
          <div className="flex flex-col gap-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t("d6Governance.seating.title")}</CardTitle>
                <CardDescription>{t("coop.council.methodHint")}</CardDescription>
              </CardHeader>
              <CardContent>
                {sectionErrors.method ?? (council ? <SeatingExplainer method={council.method} /> : <Loading />)}
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t("coop.board.title")}</CardTitle>
                <CardDescription>{t("coop.board.intro")}</CardDescription>
              </CardHeader>
              <CardContent>
                {board === null ? (
                  (sectionErrors.board ?? <Loading />)
                ) : board.length === 0 ? (
                  <EmptyState
                    data-testid="council-board-empty"
                    icon={UserGroupIcon}
                    headingLevel={3}
                    title={t("coop.board.empty")}
                    description={t("settings.coop.boardEmptyHint")}
                  />
                ) : (
                  <BoardSeats board={board} />
                )}
              </CardContent>
            </Card>
          </div>
        }
      />
    </PageContainer>
  );
}

/** `/coop/settings`: every governance setting in words, by theme, protected flags and the decision that last set each. */
export function SettingsPage({
  settings,
  error = null,
}: {
  settings: SettingDto[] | null;
  /** Shown in place of the list when it failed to load (F3); the header and the note stay. */
  error?: React.ReactNode;
}): React.JSX.Element {
  return (
    <PageContainer data-testid="settings" width="default" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("coop.settings.title")}
        description={t("coop.settings.intro")}
        tabs={<CoopTabs current="settings" />}
      />
      <AlertCallout
        tone="info"
        title={t("coop.settings.protectedTitle")}
        description={t("coop.settings.protectedHint")}
      />
      {settings === null ? (error ?? <Loading />) : <GovernanceSettingsGroups settings={settings} />}
    </PageContainer>
  );
}
