// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ChannelAvatar,
  EmptyState,
  Skeleton,
  SkeletonAvatar,
  SkeletonGroup,
  SkeletonText,
  StatusBadge,
  formatNumber,
  useLocale,
} from "@commonair/ui";
import { GovernanceOutcomeList } from "@commonair/ui/blocks/coop";
import { BreakdownBar, ListPanel } from "@commonair/ui/blocks/data";
import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { File01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  activeClasses,
  classLabel,
  governanceOutcomes,
  membersByClass,
  type CoopMonthDto,
  type CouncilDto,
  type MembershipViewDto,
  type ProposalDto,
} from "../../lib/coop.ts";
import { CoopTabs } from "./nav.tsx";
import { ProposalItem } from "./proposals.tsx";
import { outcomeItem } from "./transparency.tsx";

export interface CoopOverviewProps {
  signedIn: boolean;
  /** Signed in: the caller's memberships (null while loading). */
  membership: MembershipViewDto | null;
  /** Proposals in discussion, council review or voting (null while loading). */
  openProposals: ProposalDto[] | null;
  council: CouncilDto | null;
  /** Newest month first (member counts, recent decisions). */
  months: CoopMonthDto[] | null;
  /** Shown in place of the membership card when the caller's membership failed to load. */
  membershipError?: React.ReactNode;
  /**
   * Shown in place of a section's content when its load failed (F3); the rest of the page renders.
   * `decisions` and `byClass` both come from the months load.
   */
  sectionErrors?: Partial<Record<OverviewSection, React.ReactNode>>;
  /** The join band (D2.5), under the header: for visitors and accounts that aren't members yet. */
  joinBand?: React.ReactNode;
}

/** The overview's sections that load on their own. */
export type OverviewSection = "open" | "decisions" | "council" | "byClass";

function Loading(): React.JSX.Element {
  return (
    <SkeletonGroup label={t("coop.loading")}>
      <Skeleton className="h-24 w-full" />
    </SkeletonGroup>
  );
}

/** The council list while it loads: rows the size of a member, busy for assistive tech. */
function CouncilLoading(): React.JSX.Element {
  return (
    <SkeletonGroup data-testid="coop-council-loading" label={t("coop.loading")} className="flex flex-col gap-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <SkeletonAvatar size="sm" />
          <SkeletonText lines={2} />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** How many decisions the overview shows; the rest are on the proposals list (F19). */
export const RECENT_DECISIONS = 5;

/** The newest decided proposals first, at most `RECENT_DECISIONS`. */
export function recentDecisions(months: readonly CoopMonthDto[] | null): ReturnType<typeof governanceOutcomes> {
  if (!months) return [];
  return (
    governanceOutcomes(months)
      .filter((g) => g.passed !== null)
      .map((g, index) => ({ g, index }))
      // Newest decision first; months arrive newest first, so the original order breaks ties.
      .sort((a, b) => (b.g.decidedAt ?? "").localeCompare(a.g.decidedAt ?? "") || a.index - b.index)
      .slice(0, RECENT_DECISIONS)
      .map(({ g }) => g)
  );
}

/** `/coop`: your membership, open proposals, recent decisions, the council and members by class. */
export function CoopOverview({
  signedIn,
  membership,
  openProposals,
  council,
  months,
  membershipError = null,
  sectionErrors = {},
  joinBand = null,
}: CoopOverviewProps): React.JSX.Element {
  const { locale } = useLocale();
  const counts = membersByClass(months);
  const classes = activeClasses(membership);
  const decisions = recentDecisions(months);
  return (
    <PageContainer data-testid="coop" width="wide" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("coop.title")} description={t("coop.intro")} tabs={<CoopTabs current="overview" />} />
      {joinBand}
      <SplitLayout
        asideWidth="lg"
        main={
          <div className="flex flex-col gap-6">
            {signedIn &&
              (membershipError ??
                (membership ? (
                  <Card data-testid="coop-membership-card" data-classes={classes.join(",")}>
                    <CardHeader>
                      <CardTitle>{t("coop.card.title")}</CardTitle>
                      <CardDescription className="flex flex-wrap items-center gap-2">
                        {classes.length === 0
                          ? t("coop.card.none")
                          : classes.map((c) => (
                              <StatusBadge key={c} tone="success">
                                {classLabel(c)}
                              </StatusBadge>
                            ))}
                      </CardDescription>
                      <CardAction>
                        <Button
                          variant="outline"
                          size="xs"
                          nativeButton={false}
                          render={
                            <Link
                              to="/coop/membership"
                              aria-label={t("coop.card.manage")}
                              data-testid="coop-membership-link"
                            />
                          }
                        >
                          {classes.length === 0 ? t("coop.card.join") : t("coop.card.manageShort")}
                        </Button>
                      </CardAction>
                    </CardHeader>
                  </Card>
                ) : (
                  <Loading />
                )))}
            <Section
              heading={t("coop.open.title")}
              action={
                <Button
                  variant="ghost"
                  size="xs"
                  nativeButton={false}
                  render={<Link to="/coop/proposals" aria-label={t("coop.open.all")} />}
                >
                  {t("coop.open.all")}
                </Button>
              }
            >
              {openProposals === null ? (
                (sectionErrors.open ?? <Loading />)
              ) : openProposals.length === 0 ? (
                <EmptyState
                  icon={File01Icon}
                  headingLevel={3}
                  title={t("coop.open.empty")}
                  description={t("coop.open.emptyHint")}
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {openProposals.map((p) => (
                    <ProposalItem key={p.id} proposal={p} testId="coop-open-proposal" headingLevel={3} />
                  ))}
                </div>
              )}
            </Section>
            {(sectionErrors.decisions || decisions.length > 0) && (
              <Section
                heading={t("coop.decisions.title")}
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    nativeButton={false}
                    render={
                      <Link to="/coop/proposals" search={{ status: "decided" }} data-testid="coop-all-decisions" />
                    }
                  >
                    {t("polish.coop.allDecisions")}
                  </Button>
                }
              >
                {sectionErrors.decisions ?? (
                  <GovernanceOutcomeList
                    data-testid="coop-recent-decisions"
                    label={t("coop.decisions.title")}
                    items={decisions.map(outcomeItem)}
                  />
                )}
              </Section>
            )}
          </div>
        }
        aside={
          <div className="flex flex-col gap-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t("coop.byClass.title")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {sectionErrors.byClass ?? (
                  <BreakdownBar
                    data-testid="coop-members-by-class"
                    data-streamer={counts.streamer}
                    data-viewer={counts.viewer}
                    data-worker={counts.worker}
                    label={t("coop.byClass.title")}
                    segments={[
                      { id: "streamer", label: classLabel("streamer"), value: counts.streamer },
                      { id: "viewer", label: classLabel("viewer"), value: counts.viewer },
                      { id: "worker", label: classLabel("worker"), value: counts.worker },
                    ]}
                    formatValue={(value) => formatNumber(value, locale)}
                    formatLabel={(segments, shares) =>
                      segments
                        .map((segment, i) => t("money.shareLabel", { label: segment.label, share: shares[i] ?? 0 }))
                        .join(t("common.listSeparator"))
                    }
                  />
                )}
                <p>{t("coop.byClass.protectedNote")}</p>
              </CardContent>
            </Card>
            <ListPanel
              title={t("coop.council.title")}
              action={
                <Button
                  variant="ghost"
                  size="xs"
                  nativeButton={false}
                  render={<Link to="/coop/council" aria-label={t("coop.council.more")} />}
                >
                  {t("coop.council.more")}
                </Button>
              }
              aria-busy={council || sectionErrors.council ? undefined : true}
              empty={council ? <p>{t("coop.council.empty")}</p> : (sectionErrors.council ?? <CouncilLoading />)}
              items={(council?.members ?? []).map((m) => ({
                id: m.user.id,
                attributes: { "data-testid": "coop-council-member", "data-user-id": m.user.id, "data-rank": m.rank },
                media: <ChannelAvatar name={m.user.displayName} size="sm" decorative />,
                title: m.user.displayName,
                description: t("coop.council.rank", { rank: m.rank }),
              }))}
            />
          </div>
        }
      />
    </PageContainer>
  );
}
