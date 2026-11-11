// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, Skeleton, SkeletonGroup, useLocale } from "@commonair/ui";
import { ProposalRow, proposalStatusTone } from "@commonair/ui/blocks/coop";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { Add01Icon, File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  isOpenProposal,
  parseProposalFilter,
  proposalFilterOptions,
  proposalStatusLabel,
  type ProposalDto,
  type ProposalFilter,
  type SettingDto,
} from "../../lib/coop.ts";
import { decidingBar, excerpt, resultBars, voteRule } from "../governance/model.ts";
import { NextStepText, ParticipationBar, resultRuleText } from "../governance/votes.tsx";
import { CoopTabs } from "./nav.tsx";

/**
 * One proposal as ProposalCard v2 (`proposal-item` on the list, `coop-open-proposal` on /coop):
 * title, excerpt, author, tags, the next step with its countdown, turnout against quorum while
 * voting (counts only: no running tally) and the result with its deciding rule once decided.
 * The whole card is one link.
 */
export function ProposalItem({
  proposal,
  testId,
  headingLevel,
  settings = null,
  now,
}: {
  proposal: ProposalDto;
  testId: "proposal-item" | "coop-open-proposal";
  headingLevel?: 2 | 3;
  /** `coop.settings`, for the quorum tick (null: the bar has no tick). */
  settings?: readonly SettingDto[] | null;
  /** The clock the countdown reads (tests); defaults to now. */
  now?: number;
}): React.JSX.Element {
  const { locale } = useLocale();
  // The first render's clock (stable across re-renders); the countdown itself ticks live.
  const [mountedAt] = React.useState(() => Date.now());
  const clock = now ?? mountedAt;
  const rule = voteRule(proposal.kind, settings);
  const bars = proposal.tally ? resultBars(proposal.tally, rule) : [];
  const deciding = proposal.tally ? decidingBar(bars, proposal.tally.passed) : null;
  const card = {
    title: proposal.title,
    link: { render: <Link to="/coop/proposals/$id" params={{ id: proposal.id }} /> },
    excerpt: excerpt(proposal.body),
    author: {
      name: proposal.author.displayName,
      label: t("d6Governance.card.author", { name: proposal.author.displayName }),
    },
    status: proposalStatusLabel(proposal.status),
    statusTone: proposalStatusTone(proposal.status),
    protectedLabel: proposal.kind === "protected" ? t("d6Governance.protected") : undefined,
    affectsCreatorsLabel: proposal.affectsCreators ? t("coop.proposal.affectsCreators") : undefined,
    canVoteLabel:
      proposal.status === "voting"
        ? proposal.myVote
          ? t("d6Governance.card.voted")
          : proposal.canVote
            ? t("d6Governance.card.canVote")
            : undefined
        : undefined,
    headingLevel,
    next: <NextStepText proposal={proposal} now={clock} />,
    participation:
      proposal.participation && isOpenProposal(proposal.status) ? (
        <ParticipationBar participation={proposal.participation} rule={rule} data-testid="proposal-participation" />
      ) : undefined,
    result: proposal.tally
      ? {
          passed: proposal.tally.passed,
          label: proposal.tally.passed ? t("coop.tally.passed") : t("coop.tally.rejected"),
          rule: deciding ? resultRuleText(deciding, locale) : undefined,
        }
      : undefined,
  };
  return testId === "coop-open-proposal" ? (
    <ProposalRow
      data-testid="coop-open-proposal"
      data-proposal-id={proposal.id}
      data-status={proposal.status}
      data-kind={proposal.kind}
      {...card}
    />
  ) : (
    <ProposalRow
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
  /** `coop.settings` for the quorum ticks; null while loading or failed (the bars have no tick). */
  settings?: readonly SettingDto[] | null;
  /** The clock the countdowns read (tests). */
  now?: number;
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
  settings = null,
  now,
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
              <ProposalItem key={p.id} proposal={p} testId="proposal-item" settings={settings} now={now} />
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
