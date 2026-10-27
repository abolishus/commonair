// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChannelAvatar, ConfirmDialog, RelativeTime, StatusBadge, formatNumber, useLocale } from "@commonair/ui";
import {
  CouncilRespondForm,
  CouncilResponseCard,
  ProposalChangeSummary,
  ProposalKindBadge,
  TallyTable,
  VotePanel,
  VoteParticipation,
  proposalStatusTone,
} from "@commonair/ui/blocks/coop";
import { Timeline } from "@commonair/ui/blocks/data";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { CommentComposer } from "@commonair/ui/blocks/forms";
import { Breadcrumbs, PageHeader, Section } from "@commonair/ui/blocks/headers";
import { CommentItem, CommentList } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  COMMENT_MAX,
  COUNCIL_RESPONSE_MAX,
  authorActions,
  isOpenProposal,
  kindLabel,
  proposalStatusLabel,
  proposalTimeline,
  stanceLabel,
  stanceOptions,
  tallyReasonText,
  tallyRows,
  tallyRuleLabel,
  voteChoiceLabel,
  voteChoices,
  votingOpen,
  type CouncilStance,
  type ProposalCommentDto,
  type ProposalDto,
  type VoteChoice,
} from "../../lib/coop.ts";

export interface ProposalPageProps {
  proposal: ProposalDto;
  /** null while loading. */
  comments: ProposalCommentDto[] | null;
  hasMoreComments: boolean;
  loadingMoreComments: boolean;
  onLoadMoreComments: () => void;
  /** The viewer's user id, null when signed out. */
  meId: string | null;
  /** An active member: may comment while comments are open. */
  member: boolean;
  /** Seated in the current council term. */
  councilMember: boolean;
  /** The clock the vote window is judged by (ticks while the page polls). */
  now: number;
  /** The API said `voting_closed`: the ballot gives way until the page reloads the proposal. */
  votingClosed: boolean;
  onSubmitProposal: () => Promise<void>;
  onWithdraw: () => Promise<void>;
  onActionError: (err: unknown) => void;
  onComment: (body: string) => Promise<void>;
  onVote: (choice: VoteChoice) => Promise<void>;
  onCouncilRespond: (value: { stance: CouncilStance; body: string }) => Promise<void>;
  /** Shown in the discussion when the comments failed to load (the proposal itself still shows). */
  commentsError?: React.ReactNode;
  /** Shown in place of the comment form when the caller's membership failed to load. */
  memberError?: React.ReactNode;
  /** Shown in place of the council response form when the council failed to load. */
  councilError?: React.ReactNode;
}

function tallyLabels(): React.ComponentProps<typeof TallyTable>["labels"] {
  return {
    caption: t("coop.tally.caption"),
    scope: t("coop.tally.scope"),
    yes: t("coop.tally.yes"),
    no: t("coop.tally.no"),
    abstain: t("coop.tally.abstain"),
    eligible: t("coop.tally.eligible"),
    turnout: t("coop.tally.turnout"),
    checks: t("coop.tally.checks"),
    checkPassed: t("coop.tally.checkPassed"),
    checkFailed: t("coop.tally.checkFailed"),
  };
}

const parseStance = (value: string): CouncilStance | null =>
  stanceOptions().find((s) => s.value === value)?.value ?? null;
const parseChoice = (value: string): VoteChoice | null => voteChoices().find((c) => c.value === value)?.value ?? null;

/**
 * `/coop/proposals/$id` in every state: the proposal and what it changes, the timeline, author
 * actions, discussion, the council's response (or the respond form), the ballot with participation
 * only while voting is open (secret ballot: never a running tally), and the tally once decided.
 */
export function ProposalPage({
  proposal: p,
  comments,
  hasMoreComments,
  loadingMoreComments,
  onLoadMoreComments,
  meId,
  member,
  councilMember,
  now,
  votingClosed,
  onSubmitProposal,
  onWithdraw,
  onActionError,
  onComment,
  onVote,
  onCouncilRespond,
  commentsError = null,
  memberError = null,
  councilError = null,
}: ProposalPageProps): React.JSX.Element {
  const { locale } = useLocale();
  const [comment, setComment] = React.useState("");
  const [commenting, setCommenting] = React.useState(false);
  const [voting, setVoting] = React.useState(false);
  const [stance, setStance] = React.useState("");
  const [response, setResponse] = React.useState("");
  const [responding, setResponding] = React.useState(false);

  const actions = authorActions(p, meId);
  const commentsOpen = isOpenProposal(p.status);
  const ballotOpen = votingOpen(p, now) && !votingClosed;
  const participation = p.participation;
  const participationView = participation ? (
    <VoteParticipation
      data-testid="vote-participation"
      voted={participation.voted}
      eligible={participation.eligible}
      label={t("coop.participation.label")}
      valueText={t("coop.participation.value", {
        voted: formatNumber(participation.voted, locale),
        eligible: formatNumber(participation.eligible, locale),
      })}
      note={t("coop.participation.noTally")}
    />
  ) : null;

  const busy = async (set: (v: boolean) => void, run: () => Promise<void>) => {
    set(true);
    try {
      await run();
    } finally {
      set(false);
    }
  };

  return (
    <PageContainer
      data-testid="proposal"
      data-proposal-id={p.id}
      data-status={p.status}
      data-kind={p.kind}
      data-affects-creators={String(p.affectsCreators)}
      width="wide"
      className="py-8"
    >
      <SplitLayout
        asideWidth="lg"
        main={
          <article className="flex flex-col gap-6">
            <PageHeader
              breadcrumbs={
                <Breadcrumbs
                  label={t("coop.breadcrumb")}
                  items={[
                    { label: t("coop.title"), render: <Link to="/coop" /> },
                    { label: t("coop.proposals.title"), render: <Link to="/coop/proposals" /> },
                    { label: p.title },
                  ]}
                />
              }
              title={p.title}
              meta={
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={proposalStatusTone(p.status)}>{proposalStatusLabel(p.status)}</StatusBadge>
                    <ProposalKindBadge kind={p.kind} label={kindLabel(p.kind)} />
                    {p.affectsCreators && (
                      <StatusBadge tone="neutral">{t("coop.proposal.affectsCreators")}</StatusBadge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ChannelAvatar name={p.author.displayName} size="xs" decorative />
                    <span>{p.author.displayName}</span>
                    <RelativeTime date={p.createdAt} />
                  </div>
                </div>
              }
              actions={
                actions.submit || actions.edit || actions.withdraw ? (
                  <>
                    {actions.submit && (
                      <ConfirmDialog
                        trigger={
                          <Button size="sm" data-testid="proposal-submit">
                            {t("coop.proposal.submit")}
                          </Button>
                        }
                        title={t("coop.proposal.submitTitle")}
                        description={t("coop.proposal.submitHint")}
                        confirmLabel={t("coop.proposal.submit")}
                        onConfirm={onSubmitProposal}
                        onError={onActionError}
                      />
                    )}
                    {actions.edit && (
                      <Button
                        size="sm"
                        variant="outline"
                        nativeButton={false}
                        render={
                          <Link
                            to="/coop/proposals/$id/edit"
                            params={{ id: p.id }}
                            aria-label={t("coop.proposal.edit")}
                            data-testid="proposal-edit"
                          />
                        }
                      >
                        {t("coop.proposal.edit")}
                      </Button>
                    )}
                    {actions.withdraw && (
                      <ConfirmDialog
                        trigger={
                          <Button size="sm" variant="ghost" data-testid="proposal-withdraw">
                            {t("coop.proposal.withdraw")}
                          </Button>
                        }
                        title={t("coop.proposal.withdrawTitle")}
                        description={t("coop.proposal.withdrawHint")}
                        confirmLabel={t("coop.proposal.withdraw")}
                        variant="destructive"
                        onConfirm={onWithdraw}
                        onError={onActionError}
                      />
                    )}
                  </>
                ) : undefined
              }
            />
            <Section heading={t("coop.proposal.body")}>
              <p className="whitespace-pre-line wrap-anywhere">{p.body}</p>
            </Section>
            <Section heading={t("coop.proposal.changes")}>
              <ProposalChangeSummary
                items={p.changes.map((c) => ({ key: c.key, from: c.from, to: c.to, protected: c.protected }))}
                labels={{
                  from: t("coop.proposal.changeFrom"),
                  to: t("coop.proposal.changeTo"),
                  protected: t("coop.form.changeProtected"),
                  empty: t("coop.proposal.noChanges"),
                }}
                itemProps={{ "data-testid": "proposal-change-summary" }}
              />
            </Section>
            {p.councilResponse ? (
              <CouncilResponseCard
                data-testid="council-response"
                stance={p.councilResponse.stance}
                stanceLabel={stanceLabel(p.councilResponse.stance)}
                title={t("coop.council.responseTitle")}
                body={p.councilResponse.body}
                publishedAt={<RelativeTime date={p.councilResponse.publishedAt} />}
              />
            ) : p.councilResponseMissed ? (
              <AlertCallout
                data-testid="council-response-missed"
                tone="warning"
                title={t("coop.council.missedTitle")}
                description={t("coop.council.missedHint")}
              />
            ) : null}
            {p.status === "council_review" &&
              !p.councilResponse &&
              (councilError ??
                (councilMember ? (
                  <CouncilRespondForm
                    data-testid="council-respond"
                    title={t("coop.council.respondTitle")}
                    description={t("coop.council.respondHint")}
                    stanceLabel={t("coop.council.stance")}
                    stances={stanceOptions()}
                    stance={stance}
                    onStanceChange={setStance}
                    bodyLabel={t("coop.council.respondBody")}
                    bodyHint={t("coop.council.respondBodyHint")}
                    body={response}
                    onBodyChange={setResponse}
                    maxLength={COUNCIL_RESPONSE_MAX}
                    submitLabel={t("coop.council.respondSubmit")}
                    pending={responding}
                    onSubmit={(value) => {
                      const chosen = parseStance(value.stance);
                      if (!chosen || responding) return;
                      void busy(setResponding, () => onCouncilRespond({ stance: chosen, body: value.body })).catch(
                        onActionError,
                      );
                    }}
                    stanceProps={{ "data-testid": "council-respond-stance" }}
                    stanceItemProps={(value) => ({ "data-testid": `council-respond-stance-${value}` })}
                    bodyProps={{ "data-testid": "council-respond-body" }}
                    submitProps={{ "data-testid": "council-respond-submit" }}
                  />
                ) : (
                  <AlertCallout
                    tone="info"
                    title={t("coop.council.inReviewTitle")}
                    description={t("coop.council.inReviewHint")}
                  />
                )))}
            {p.status !== "draft" && (
              <Section heading={t("coop.discussion.title")}>
                {commentsError}
                {comments === null ? null : comments.length === 0 ? (
                  <p>{t("coop.discussion.empty")}</p>
                ) : (
                  <CommentList label={t("coop.discussion.title")}>
                    {comments.map((c) => (
                      <CommentItem
                        key={c.id}
                        data-testid="proposal-comment"
                        data-comment-id={c.id}
                        data-author-id={c.author.id}
                        author={c.author.displayName}
                        time={<RelativeTime date={c.createdAt} />}
                      >
                        <p className="whitespace-pre-line wrap-anywhere">{c.body}</p>
                      </CommentItem>
                    ))}
                  </CommentList>
                )}
                {hasMoreComments && (
                  <div className="flex justify-center">
                    <Button variant="outline" size="sm" disabled={loadingMoreComments} onClick={onLoadMoreComments}>
                      {t("coop.loadMore")}
                    </Button>
                  </div>
                )}
                {commentsOpen && memberError ? (
                  memberError
                ) : commentsOpen && member ? (
                  <CommentComposer
                    label={t("coop.discussion.add")}
                    placeholder={t("coop.discussion.placeholder")}
                    submitLabel={t("coop.discussion.post")}
                    value={comment}
                    onValueChange={setComment}
                    disabled={commenting}
                    textareaProps={{ maxLength: COMMENT_MAX }}
                    onSubmit={(body) => {
                      const text = body.trim();
                      if (!text || commenting) return;
                      void busy(setCommenting, async () => {
                        await onComment(text);
                        setComment("");
                      }).catch(onActionError);
                    }}
                    data-textarea-testid="proposal-comment-body"
                    data-submit-testid="proposal-comment-submit"
                  />
                ) : (
                  <p>{commentsOpen ? t("coop.discussion.membersOnly") : t("coop.discussion.closed")}</p>
                )}
              </Section>
            )}
          </article>
        }
        aside={
          <div className="flex flex-col gap-4">
            {p.status === "voting" &&
              (ballotOpen ? (
                <VotePanel
                  data-testid="vote-panel"
                  title={t("coop.vote.title")}
                  description={t("coop.vote.secret")}
                  choiceLabel={t("coop.vote.title")}
                  choices={voteChoices()}
                  myVote={p.myVote}
                  myVoteText={p.myVote ? t("coop.vote.yours", { choice: voteChoiceLabel(p.myVote) }) : undefined}
                  canVote={p.canVote}
                  cannotVoteReason={meId ? t("coop.vote.notInElectorate") : t("coop.vote.signIn")}
                  submitLabel={p.myVote ? t("coop.vote.change") : t("coop.vote.cast")}
                  pending={voting}
                  onSubmit={(value) => {
                    const choice = parseChoice(value);
                    if (!choice || voting) return;
                    void busy(setVoting, () => onVote(choice)).catch(onActionError);
                  }}
                  groupProps={{ "data-testid": "vote-choice" }}
                  choiceProps={(value) => ({ "data-testid": `vote-choice-${value}` })}
                  submitProps={{ "data-testid": "vote-submit" }}
                  participation={participationView}
                />
              ) : (
                <>
                  <AlertCallout
                    tone="info"
                    data-testid="vote-closed"
                    title={t("coop.vote.closedTitle")}
                    description={t("coop.vote.closedHint")}
                  />
                  {participationView}
                </>
              ))}
            {p.tally && (
              <Card size="sm">
                <CardHeader>
                  <CardTitle>{t("coop.tally.title")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <TallyTable
                    data-testid="tally"
                    data-reason={p.tally.reason}
                    passed={p.tally.passed}
                    outcomeLabel={p.tally.passed ? t("coop.tally.passed") : t("coop.tally.rejected")}
                    reason={tallyReasonText(p.tally.reason)}
                    rows={tallyRows(p.tally.breakdown)}
                    checks={p.tally.breakdown.checks.map((c) => ({
                      rule: c.rule,
                      label: tallyRuleLabel(c.rule),
                      detail: c.detail,
                      passed: c.passed,
                    }))}
                    labels={tallyLabels()}
                    rowProps={{ "data-testid": "tally-row" }}
                    checkProps={{ "data-testid": "tally-check" }}
                  />
                </CardContent>
              </Card>
            )}
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t("coop.timeline.title")}</CardTitle>
              </CardHeader>
              <CardContent>
                <Timeline
                  data-testid="proposal-timeline"
                  steps={proposalTimeline(p).map((step) => ({
                    id: step.id,
                    label: step.label,
                    meta: step.until ? <RelativeTime date={step.until} /> : undefined,
                    state: step.state,
                    attributes: { "data-testid": `proposal-timeline-${step.id}`, "data-at": step.at },
                  }))}
                />
              </CardContent>
            </Card>
          </div>
        }
      />
    </PageContainer>
  );
}
