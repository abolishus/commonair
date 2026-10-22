// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, Skeleton, SkeletonGroup, formatNumber, useLocale } from "@commonair/ui";
import { ElectionCard, GovernanceSettingsList, SeatList, formatSettingValue } from "@commonair/ui/blocks/coop";
import { KeyValueList, type KeyValueRow } from "@commonair/ui/blocks/data";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, ResponsiveGrid, SplitLayout } from "@commonair/ui/layouts";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  classLabel,
  electionStatusLabel,
  type BoardSeatDto,
  type CouncilDto,
  type ElectionDto,
  type SettingDto,
} from "../../lib/coop.ts";
import { CoopTabs } from "./nav.tsx";

function Loading(): React.JSX.Element {
  return (
    <SkeletonGroup label={t("coop.loading")}>
      <Skeleton className="h-32 w-full" />
    </SkeletonGroup>
  );
}

/** A method value: numbers through the locale, anything structured as JSON. */
function methodValue(value: unknown, locale: string): string {
  if (typeof value === "number") return formatNumber(value, locale);
  if (typeof value === "string") return value;
  return formatSettingValue(value);
}

export interface CouncilPageProps {
  council: CouncilDto | null;
  board: BoardSeatDto[] | null;
  elections: ElectionDto[] | null;
}

/** `/coop/council`: the current creator council and how it was seated, board seats, elections (read-only). */
export function CouncilPage({ council, board, elections }: CouncilPageProps): React.JSX.Element {
  const { locale } = useLocale();
  const method: KeyValueRow[] = Object.entries(council?.method ?? {}).map(([key, value]) => ({
    term: key,
    value: methodValue(value, locale),
  }));
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
      <SplitLayout
        asideWidth="lg"
        main={
          <div className="flex flex-col gap-6">
            <Section heading={t("coop.council.title")}>
              {council === null ? (
                <Loading />
              ) : (
                <SeatList
                  label={t("coop.council.title")}
                  itemProps={{ "data-testid": "council-member" }}
                  items={council.members.map((m) => ({
                    userId: m.user.id,
                    name: m.user.displayName,
                    rank: m.rank,
                    score: m.contributionScore,
                    description: t("coop.council.rankScore", {
                      rank: m.rank,
                      score: formatNumber(m.contributionScore, locale),
                    }),
                  }))}
                  empty={
                    <EmptyState
                      icon={UserGroupIcon}
                      headingLevel={3}
                      title={t("coop.council.emptyTitle")}
                      description={t("coop.council.emptyHint")}
                    />
                  }
                />
              )}
              {council?.endsAt && (
                <p>
                  {t("coop.council.termEnds")} <RelativeTime date={council.endsAt} />
                </p>
              )}
            </Section>
            <Section heading={t("coop.elections.title")} description={t("coop.elections.intro")}>
              {elections === null ? (
                <Loading />
              ) : elections.length === 0 ? (
                <p>{t("coop.elections.empty")}</p>
              ) : (
                <ResponsiveGrid cols={2}>
                  {elections.map((e) => (
                    <ElectionCard
                      key={e.id}
                      data-testid="election-item"
                      electionId={e.id}
                      memberClass={e.class}
                      status={e.status}
                      statusLabel={electionStatusLabel(e.status)}
                      title={t("coop.elections.seat", { class: classLabel(e.class) })}
                      details={[
                        { term: t("coop.elections.seats"), value: formatNumber(e.seats, locale) },
                        {
                          term: t("coop.elections.nominationsClose"),
                          value: <RelativeTime date={e.nominationsCloseAt} />,
                        },
                        { term: t("coop.elections.votingEnds"), value: <RelativeTime date={e.votingEndsAt} /> },
                      ]}
                      candidates={e.candidates.map((c) => ({
                        userId: c.user.id,
                        name: c.user.displayName,
                        statement: c.statement || undefined,
                        votes:
                          c.votes === null
                            ? undefined
                            : t("coop.elections.votes", { count: formatNumber(c.votes, locale) }),
                        elected: c.elected,
                      }))}
                      labels={{
                        candidates: t("coop.elections.candidates"),
                        elected: t("coop.elections.elected"),
                        noCandidates: t("coop.elections.noCandidates"),
                      }}
                    />
                  ))}
                </ResponsiveGrid>
              )}
            </Section>
          </div>
        }
        aside={
          <div className="flex flex-col gap-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t("coop.council.methodTitle")}</CardTitle>
                <CardDescription>{t("coop.council.methodHint")}</CardDescription>
              </CardHeader>
              <CardContent>
                <KeyValueList data-testid="council-method" rows={method} />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t("coop.board.title")}</CardTitle>
                <CardDescription>{t("coop.board.intro")}</CardDescription>
              </CardHeader>
              <CardContent>
                {board === null ? (
                  <Loading />
                ) : (
                  <SeatList
                    label={t("coop.board.title")}
                    itemProps={{ "data-testid": "board-seat" }}
                    items={board.map((seat) => ({
                      userId: seat.user.id,
                      name: seat.user.displayName,
                      memberClass: seat.class,
                      description: t("coop.board.seat", { class: classLabel(seat.class) }),
                    }))}
                    empty={<p>{t("coop.board.empty")}</p>}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        }
      />
    </PageContainer>
  );
}

/** `/coop/settings`: every governance setting, protected flags and the decision that last set it. */
export function SettingsPage({ settings }: { settings: SettingDto[] | null }): React.JSX.Element {
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
      {settings === null ? (
        <Loading />
      ) : (
        <GovernanceSettingsList
          itemProps={{ "data-testid": "setting-row" }}
          labels={{
            protected: t("coop.settings.protected"),
            seeded: t("coop.settings.seeded"),
            setBy: t("coop.settings.setBy"),
          }}
          items={settings.map((s) => ({
            key: s.key,
            description: s.description,
            value: s.value,
            protected: s.protected,
            updatedAt: <RelativeTime date={s.updatedAt} />,
            updatedBy: s.updatedByProposalId
              ? {
                  proposalId: s.updatedByProposalId,
                  label: t("coop.settings.proposal"),
                  link: { render: <Link to="/coop/proposals/$id" params={{ id: s.updatedByProposalId }} /> },
                }
              : null,
          }))}
        />
      )}
    </PageContainer>
  );
}
