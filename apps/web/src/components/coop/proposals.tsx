// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, Skeleton, SkeletonGroup, formatNumber, useLocale } from "@commonair/ui";
import { proposalStatusTone } from "@commonair/ui/blocks/coop";
import { ProposalCard } from "@commonair/ui/blocks/data";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { Add01Icon, File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  isOpenProposal,
  kindLabel,
  parseProposalFilter,
  proposalFilterOptions,
  proposalStatusLabel,
  type ProposalDto,
  type ProposalFilter,
} from "../../lib/coop.ts";
import { CoopTabs } from "./nav.tsx";

/**
 * One proposal as a `ProposalCard` (`proposal-item` on the list, `coop-open-proposal` on /coop).
 * Open votes show participation only; results appear once decided.
 */
export function ProposalItem({
  proposal,
  testId,
  headingLevel,
}: {
  proposal: ProposalDto;
  testId: "proposal-item" | "coop-open-proposal";
  headingLevel?: 2 | 3;
}): React.JSX.Element {
  const { locale } = useLocale();
  const participation = proposal.participation;
  const percent =
    participation && participation.eligible > 0 ? Math.round((participation.voted / participation.eligible) * 100) : 0;
  const card = {
    title: proposal.title,
    link: { render: <Link to="/coop/proposals/$id" params={{ id: proposal.id }} /> },
    status: proposalStatusLabel(proposal.status),
    statusTone: proposalStatusTone(proposal.status),
    protectedLabel: proposal.kind === "protected" ? kindLabel("protected") : undefined,
    headingLevel,
    progress: participation
      ? {
          label: t("coop.participation.label"),
          value: percent,
          valueText: t("coop.participation.value", {
            voted: formatNumber(participation.voted, locale),
            eligible: formatNumber(participation.eligible, locale),
          }),
          note: isOpenProposal(proposal.status) ? t("coop.participation.noTally") : undefined,
        }
      : undefined,
  };
  return testId === "coop-open-proposal" ? (
    <ProposalCard
      data-testid="coop-open-proposal"
      data-proposal-id={proposal.id}
      data-status={proposal.status}
      data-kind={proposal.kind}
      {...card}
    />
  ) : (
    <ProposalCard
      data-testid="proposal-item"
      data-proposal-id={proposal.id}
      data-status={proposal.status}
      data-kind={proposal.kind}
      {...card}
    />
  );
}

export interface ProposalListProps {
  /** null while loading. */
  proposals: ProposalDto[] | null;
  filter: ProposalFilter;
  onFilterChange: (filter: ProposalFilter) => void;
  /** Active members get "New proposal". */
  member: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

/** `/coop/proposals`: proposals by status; members can start a new one. */
export function ProposalList({
  proposals,
  filter,
  onFilterChange,
  member,
  hasMore,
  loadingMore,
  onLoadMore,
}: ProposalListProps): React.JSX.Element {
  return (
    <PageContainer width="wide" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("coop.proposals.title")}
        description={t("coop.proposals.intro")}
        tabs={<CoopTabs current="proposals" />}
        actions={
          member ? (
            <Button
              size="sm"
              nativeButton={false}
              render={
                <Link to="/coop/proposals/new" aria-label={t("coop.proposals.new")} data-testid="proposals-new" />
              }
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
              {t("coop.proposals.new")}
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4" data-testid="proposals">
        <ChoiceToggle
          label={t("coop.proposals.filter")}
          data-testid="proposals-filter"
          wrap
          options={proposalFilterOptions()}
          value={filter}
          onValueChange={(value) => onFilterChange(parseProposalFilter(value) ?? "all")}
        />
        {proposals === null ? (
          <SkeletonGroup label={t("coop.loading")}>
            <div className="flex flex-col gap-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </SkeletonGroup>
        ) : proposals.length === 0 ? (
          <EmptyState
            data-testid="proposals-empty"
            icon={File01Icon}
            title={t("coop.proposals.empty")}
            description={filter === "all" ? t("coop.proposals.emptyAll") : t("coop.proposals.emptyFilter")}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {proposals.map((p) => (
              <ProposalItem key={p.id} proposal={p} testId="proposal-item" />
            ))}
          </div>
        )}
        {hasMore && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
              {t("coop.loadMore")}
            </Button>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
