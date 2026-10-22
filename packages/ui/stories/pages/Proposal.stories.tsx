// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChannelAvatar, ConfirmDialog, StatusBadge, formatNumber } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { CommentItem, CommentList } from "@commonair/ui/blocks/media";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { Breadcrumbs, PageHeader, Section } from "@commonair/ui/blocks/headers";
import { FilterBar, Timeline } from "@commonair/ui/blocks/data";
import { CommentComposer } from "@commonair/ui/blocks/forms";
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
import {
  breadcrumbs,
  changes,
  choices,
  commentSorts,
  comments,
  councilResponse,
  participation,
  passedChecks,
  passedRows,
  proposal,
  stances,
  statusLabels,
  tallyChecks,
  tallyReason,
  tallyReasonText,
  tallyRows,
  timelineFor,
  type ProposalState,
} from "./fixtures/Proposal.ts";
import { LOCALE } from "./money.tsx";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/Proposal", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const TALLY_LABELS = {
  caption: "Votes by class",
  scope: "Who",
  yes: "Yes",
  no: "No",
  abstain: "Abstain",
  eligible: "Eligible",
  turnout: "Turnout",
  checks: "Rules checked",
  checkPassed: "Met",
  checkFailed: "Not met",
};

interface ProposalPageProps {
  state: ProposalState;
  /** The viewer wrote the proposal (author actions). */
  author?: boolean;
  /** The viewer sits on the current council (respond form during review). */
  councilMember?: boolean;
  /** Council review ended without a response. */
  responseMissed?: boolean;
  canVote?: boolean;
  myVote?: string | null;
}

function ProposalPage({
  state,
  author = false,
  councilMember = false,
  responseMissed = false,
  canVote = true,
  myVote = null,
}: ProposalPageProps): React.JSX.Element {
  const [sort, setSort] = React.useState("oldest");
  const [stance, setStance] = React.useState("");
  const [response, setResponse] = React.useState("");
  const decided = state === "rejected" || state === "applied";
  const commentsOpen = state === "discussion" || state === "council_review" || state === "voting";
  const reviewDone = state === "voting" || decided;
  const kind = state === "applied" ? "ordinary" : "protected";
  const shownChanges = kind === "protected" ? changes : changes.filter((change) => !change.protected);
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer
        width="wide"
        className="py-6"
        data-testid="proposal"
        data-proposal-id={proposal.id}
        data-status={state}
        data-kind={kind}
        data-affects-creators="true"
      >
        <SplitLayout
          asideWidth="lg"
          main={
            <article className="flex flex-col gap-6">
              <PageHeader
                breadcrumbs={<Breadcrumbs label="Breadcrumb" items={breadcrumbs} />}
                title={proposal.title}
                meta={
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone={proposalStatusTone(state)}>{statusLabels[state]}</StatusBadge>
                      <ProposalKindBadge
                        kind={kind}
                        label={kind === "protected" ? "Protected decision" : "Ordinary decision"}
                      />
                      <StatusBadge tone="neutral">Affects creators</StatusBadge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <ChannelAvatar name={proposal.author.name} accent={proposal.author.accent} size="xs" decorative />
                      <span>{proposal.author.name}</span>
                      <span>· {proposal.opened}</span>
                    </div>
                  </div>
                }
                actions={
                  author && (state === "draft" || state === "discussion" || state === "council_review") ? (
                    <>
                      {state === "draft" ? (
                        <ConfirmDialog
                          trigger={
                            <Button size="sm" data-testid="proposal-submit">
                              Open for discussion
                            </Button>
                          }
                          title="Open this proposal for discussion?"
                          description="Members can read and comment on it. Editing during discussion restarts the discussion period."
                          confirmLabel="Open for discussion"
                          onConfirm={() => undefined}
                        />
                      ) : null}
                      {state !== "council_review" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          render={
                            <a
                              href={`#coop/proposals/${proposal.id}/edit`}
                              aria-label="Edit"
                              data-testid="proposal-edit"
                            />
                          }
                          nativeButton={false}
                        >
                          Edit
                        </Button>
                      ) : null}
                      <ConfirmDialog
                        trigger={
                          <Button size="sm" variant="ghost" data-testid="proposal-withdraw">
                            Withdraw
                          </Button>
                        }
                        title="Withdraw this proposal?"
                        description="It stays visible as withdrawn and cannot be reopened."
                        confirmLabel="Withdraw"
                        variant="destructive"
                        onConfirm={() => undefined}
                      />
                    </>
                  ) : undefined
                }
              />
              <Section heading="Proposal">
                <p className="whitespace-pre-line">{proposal.body}</p>
              </Section>
              <Section heading="What changes">
                <ProposalChangeSummary
                  items={shownChanges}
                  labels={{ from: "Now", to: "Proposed", protected: "Protected setting" }}
                  itemProps={{ "data-testid": "proposal-change-summary" }}
                />
              </Section>
              {reviewDone && !responseMissed ? (
                <CouncilResponseCard
                  data-testid="council-response"
                  stance={councilResponse.stance}
                  stanceLabel={councilResponse.stanceLabel}
                  title="Creator council response"
                  body={councilResponse.body}
                  publishedAt={councilResponse.publishedAt}
                />
              ) : null}
              {reviewDone && responseMissed ? (
                <AlertCallout
                  data-testid="council-response-missed"
                  tone="warning"
                  title="No council response"
                  description="The creator council did not publish a response before review ended. Voting opened anyway."
                />
              ) : null}
              {state === "council_review" && councilMember ? (
                <CouncilRespondForm
                  data-testid="council-respond"
                  title="Respond for the creator council"
                  description="One response per proposal, shown on the ballot. Review ends Oct 15."
                  stanceLabel="Stance"
                  stances={stances}
                  stance={stance}
                  onStanceChange={setStance}
                  bodyLabel="Response"
                  bodyHint="Plain text. Members read it before they vote."
                  body={response}
                  onBodyChange={setResponse}
                  submitLabel="Publish response"
                  onSubmit={() => undefined}
                  stanceProps={{ "data-testid": "council-respond-stance" }}
                  stanceItemProps={(value) => ({ "data-testid": `council-respond-stance-${value}` })}
                  bodyProps={{ "data-testid": "council-respond-body" }}
                  submitProps={{ "data-testid": "council-respond-submit" }}
                />
              ) : null}
              {state === "council_review" && !councilMember ? (
                <AlertCallout
                  tone="info"
                  title="In creator council review"
                  description="The council publishes its response before voting opens on Oct 15."
                />
              ) : null}
              {state !== "draft" ? (
                <Section
                  heading="Discussion"
                  description={`${comments.length} comments`}
                  action={
                    <FilterBar
                      filters={[
                        {
                          id: "comment-sort",
                          label: "Sort comments",
                          value: sort,
                          options: commentSorts,
                          onValueChange: setSort,
                        },
                      ]}
                    />
                  }
                >
                  <CommentList label="Comments">
                    {comments.map((comment) => (
                      <CommentItem
                        key={comment.id}
                        data-testid="proposal-comment"
                        data-comment-id={comment.id}
                        data-author-id={comment.authorId}
                        author={comment.name}
                        accent={comment.accent}
                        badge={comment.memberClass}
                        time={comment.ago}
                      >
                        <p>{comment.text}</p>
                      </CommentItem>
                    ))}
                  </CommentList>
                  {commentsOpen ? (
                    <CommentComposer
                      label="Add to the discussion"
                      placeholder="Members only. Be specific, be kind."
                      submitLabel="Post comment"
                      onSubmit={() => undefined}
                      data-textarea-testid="proposal-comment-body"
                      data-submit-testid="proposal-comment-submit"
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">Comments are closed.</p>
                  )}
                </Section>
              ) : null}
            </article>
          }
          aside={
            <div className="flex flex-col gap-4">
              {state === "voting" ? (
                <VotePanel
                  data-testid="vote-panel"
                  title="Your vote"
                  description="Secret ballot: only you see your choice. You can change it until voting closes."
                  choiceLabel="Your vote"
                  choices={choices}
                  myVote={myVote}
                  myVoteText={myVote ? `You voted ${myVote}.` : undefined}
                  canVote={canVote}
                  cannotVoteReason="You were not a member when voting opened, so you are not in this vote's electorate."
                  submitLabel={myVote ? "Change vote" : "Cast vote"}
                  onSubmit={() => undefined}
                  groupProps={{ "data-testid": "vote-choice" }}
                  choiceProps={(value) => ({ "data-testid": `vote-choice-${value}` })}
                  submitProps={{ "data-testid": "vote-submit" }}
                  participation={
                    <VoteParticipation
                      data-testid="vote-participation"
                      voted={participation.voted}
                      eligible={participation.eligible}
                      label="Participation"
                      valueText={`${formatNumber(participation.voted, LOCALE)} of ${formatNumber(participation.eligible, LOCALE)} voted`}
                      note="Results are counted when voting closes on Oct 29. No running tally is shown."
                    />
                  }
                />
              ) : null}
              {decided ? (
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Result</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <TallyTable
                      data-testid="tally"
                      data-reason={state === "rejected" ? tallyReason : "passed"}
                      passed={state !== "rejected"}
                      outcomeLabel={state === "rejected" ? "Rejected" : "Passed"}
                      reason={state === "rejected" ? tallyReasonText : "Applied to the settings on Oct 29."}
                      rows={state === "rejected" ? tallyRows : passedRows}
                      checks={state === "rejected" ? tallyChecks : passedChecks}
                      labels={TALLY_LABELS}
                      rowProps={{ "data-testid": "tally-row" }}
                      checkProps={{ "data-testid": "tally-check" }}
                      locale={LOCALE}
                    />
                  </CardContent>
                </Card>
              ) : null}
              <Card size="sm">
                <CardHeader>
                  <CardTitle>Timeline</CardTitle>
                </CardHeader>
                <CardContent>
                  <Timeline
                    data-testid="proposal-timeline"
                    steps={timelineFor(state).map((step) => ({
                      id: step.id,
                      label: step.label,
                      meta: step.meta,
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
    </ViewerPage>
  );
}

/** Voting: the ballot and participation only, never a running tally. */
export const Default: Story = { render: () => <ProposalPage state="voting" myVote="yes" /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };

/** Voting, the council missed its review and the viewer is not in the electorate. */
export const VotingCannotVote: Story = {
  render: () => <ProposalPage state="voting" responseMissed canVote={false} />,
};

/** The author's draft: open for discussion, edit, withdraw. */
export const Draft: Story = { render: () => <ProposalPage state="draft" author /> };

/** Discussion, seen by its author: comments open, edit and withdraw. */
export const Discussion: Story = { render: () => <ProposalPage state="discussion" author /> };

/** Council review, seen by a council member: the respond form. */
export const CouncilReview: Story = { render: () => <ProposalPage state="council_review" councilMember /> };

/** Decided: a protected decision that passed member-wide but failed in the streamer class. */
export const Rejected: Story = { render: () => <ProposalPage state="rejected" /> };
export const RejectedMobile320: Story = { ...Rejected, ...mobile320 };

/** Decided and applied: an ordinary proposal. */
export const Applied: Story = { render: () => <ProposalPage state="applied" /> };
