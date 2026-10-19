// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { InformationCircleIcon, SquareLock01Icon } from "@hugeicons/core-free-icons";
import { ChannelAvatar, StatusBadge } from "@commonair/ui";
import { Alert, AlertDescription, AlertTitle } from "@commonair/ui/components/alert";
import { Badge } from "@commonair/ui/components/badge";
import { Button } from "@commonair/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import {
  Item,
  ItemContent,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@commonair/ui/components/item";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { Breadcrumbs, PageHeader, Section } from "@commonair/ui/blocks/headers";
import { BreakdownTally, FilterBar, Timeline } from "@commonair/ui/blocks/data";
import { CommentComposer, OptionGroup } from "@commonair/ui/blocks/forms";
import {
  breadcrumbs,
  choices,
  commentSorts,
  comments,
  proposal,
  review,
  tallies,
  tallyNote,
  timeline,
  voteNote,
} from "./fixtures/Proposal.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/Proposal", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function ProposalPage(): React.JSX.Element {
  const [vote, setVote] = React.useState("no");
  const [sort, setSort] = React.useState("helpful");
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="wide" className="py-6">
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
                      <StatusBadge tone="info">Voting</StatusBadge>
                      <StatusBadge tone="warning" icon={SquareLock01Icon}>
                        Protected decision
                      </StatusBadge>
                      <span>
                        Key: <code>{proposal.key}</code>
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <ChannelAvatar name="treasury" accent="zinc" size="xs" decorative />
                      <span>{proposal.proposer}</span>
                      <span>· {proposal.opened}</span>
                      <span>· {proposal.closes}</span>
                    </div>
                  </div>
                }
              />
              <Section heading="Summary">
                <p>{proposal.summary}</p>
              </Section>
              <Section heading="Why">
                <p>{proposal.why}</p>
              </Section>
              <Section heading="What changes">
                <ul className="flex flex-col gap-1">
                  {proposal.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              </Section>
              <Alert>
                <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
                <AlertTitle>{review.title}</AlertTitle>
                <AlertDescription>
                  <p>
                    {review.quote} <a href="#review">Full review</a>
                  </p>
                </AlertDescription>
              </Alert>
              <Section
                heading="Discussion"
                description="214 comments"
                action={
                  <FilterBar
                    filters={[{ id: "comment-sort", label: "Sort comments", value: sort, options: commentSorts, onValueChange: setSort }]}
                  />
                }
              >
                <ItemGroup>
                  {comments.map((comment) => (
                    <Item key={comment.name} size="sm">
                      <ItemMedia>
                        <ChannelAvatar name={comment.name} accent={comment.accent} size="sm" decorative />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {comment.name}
                          <Badge variant="outline">{comment.memberClass}</Badge>
                          <span>{comment.ago}</span>
                        </ItemTitle>
                        <p>{comment.text}</p>
                      </ItemContent>
                      <ItemFooter className="justify-start gap-1">
                        <Button variant="ghost" size="xs">
                          Helpful · {comment.helpful}
                        </Button>
                        <Button variant="ghost" size="xs">
                          Reply
                        </Button>
                      </ItemFooter>
                    </Item>
                  ))}
                </ItemGroup>
                <CommentComposer
                  label="Add to the discussion"
                  placeholder="Members only. Be specific, be kind."
                  submitLabel="Post comment"
                  onSubmit={() => undefined}
                />
              </Section>
            </article>
          }
          aside={
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Your vote</CardTitle>
                  <CardDescription>You can change it until voting closes.</CardDescription>
                </CardHeader>
                <CardContent>
                  <OptionGroup
                    aria-label="Choose"
                    items={choices}
                    value={vote}
                    onValueChange={setVote}
                    className="flex flex-col gap-2"
                  />
                </CardContent>
                <CardFooter className="justify-between gap-2">
                  <span>{voteNote}</span>
                  <Button size="sm">Confirm vote</Button>
                </CardFooter>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Live tally</CardTitle>
                  <CardDescription>Protected: needs both rows to pass.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {tallies.map((row) => (
                    <BreakdownTally
                      key={row.label}
                      label={row.label}
                      note={row.note}
                      status={row.status}
                      passed={row.passed}
                      segments={row.segments}
                      votesLabel="Votes"
                      votes={row.votes}
                      formatLabel={(segments, shares) =>
                        segments.map((segment, index) => `${segment.label} ${shares[index] ?? 0}%`).join(", ")
                      }
                    />
                  ))}
                  <p>{tallyNote}</p>
                </CardContent>
              </Card>
              <Card size="sm">
                <CardHeader>
                  <CardTitle>Timeline</CardTitle>
                </CardHeader>
                <CardContent>
                  <Timeline steps={timeline} />
                </CardContent>
              </Card>
            </div>
          }
        />
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <ProposalPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
