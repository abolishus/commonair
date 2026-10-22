// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChannelAvatar, StatusBadge, formatNumber } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import { BreakdownBar, ListPanel, ProposalCard, StatCard, StatGrid } from "@commonair/ui/blocks/data";
import { GovernanceOutcomeList } from "@commonair/ui/blocks/coop";
import {
  council,
  decisions,
  events,
  intro,
  memberClasses,
  membersByClass,
  membership,
  proposals,
  protectedNote,
} from "./fixtures/Coop.ts";
import { coopTabs } from "./fixtures/CoopNav.ts";
import { Amount } from "./money.tsx";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/Coop", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function CoopPage(): React.JSX.Element {
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6" data-testid="coop">
        <PageHeader
          title="The co-op"
          description={intro}
          tabs={<PageTabs variant="default" items={coopTabs("overview")} aria-label="Co-op" />}
        />
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex flex-col gap-6">
              <Card
                data-accent={membership.accent}
                data-testid="coop-membership-card"
                data-classes={memberClasses.join(",")}
              >
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ChannelAvatar name={membership.name} accent={membership.accent} size="md" decorative />
                    Your membership
                  </CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-2">
                    {membership.since}
                    <StatusBadge tone="success">{membership.standing}</StatusBadge>
                  </CardDescription>
                  <CardAction>
                    <Button
                      variant="outline"
                      size="xs"
                      render={
                        <a href="#coop/membership" aria-label="Manage membership" data-testid="coop-membership-link" />
                      }
                      nativeButton={false}
                    >
                      Manage
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <StatGrid cols={4}>
                    {membership.stats.map((stat) => (
                      <StatCard
                        key={stat.label}
                        size="sm"
                        label={stat.label}
                        value={typeof stat.value === "string" ? stat.value : <Amount value={stat.value} />}
                        hint={stat.hint}
                      />
                    ))}
                  </StatGrid>
                </CardContent>
              </Card>
              <Section
                heading="Open for voting"
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    render={<a href="#coop/proposals" aria-label="All proposals" />}
                    nativeButton={false}
                  >
                    All proposals
                  </Button>
                }
              >
                <div className="flex flex-col gap-3">
                  {proposals.map((proposal) => (
                    <ProposalCard
                      key={proposal.number}
                      data-testid="coop-open-proposal"
                      data-proposal-id={proposal.id}
                      data-status={proposal.apiStatus}
                      data-kind={proposal.protected ? "protected" : "ordinary"}
                      reference={`#${proposal.number}`}
                      title={proposal.title}
                      link={{ href: `#proposal/${proposal.number}` }}
                      summary={proposal.summary}
                      status={proposal.status}
                      statusTone={proposal.tone}
                      protectedLabel={proposal.protected ? "Protected" : undefined}
                      progress={{
                        label: `${proposal.ends} · ${proposal.comments} comments`,
                        value: proposal.turnout ?? 0,
                        valueText: proposal.turnout === null ? "— turnout" : `${proposal.turnout}% turnout`,
                        note: proposal.voted ? "You voted" : undefined,
                      }}
                    />
                  ))}
                </div>
              </Section>
              <Section heading="Recent decisions">
                <GovernanceOutcomeList
                  label="Recent decisions"
                  items={decisions.map((decision) => ({
                    ...decision,
                    link: { href: `#coop/proposals/${decision.proposalId}` },
                    protectedLabel: "Protected",
                  }))}
                />
              </Section>
            </div>
          }
          aside={
            <div className="flex flex-col gap-4">
              <Card size="sm">
                <CardHeader>
                  <CardTitle>Members by class</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <BreakdownBar
                    data-testid="coop-members-by-class"
                    data-streamer={membersByClass.find((segment) => segment.id === "streamer")?.value}
                    data-viewer={membersByClass.find((segment) => segment.id === "viewer")?.value}
                    data-worker={membersByClass.find((segment) => segment.id === "worker")?.value}
                    label="Members by class"
                    segments={membersByClass}
                    formatValue={(value) => formatNumber(value, "en-US")}
                    formatLabel={(segments, shares) =>
                      segments.map((segment, index) => `${segment.label} ${shares[index] ?? 0}%`).join(", ")
                    }
                  />
                  <p>{protectedNote}</p>
                </CardContent>
              </Card>
              <ListPanel
                title="Creator council"
                action={<span>term ends Mar 2027</span>}
                items={council.map((member) => ({
                  id: member.userId,
                  attributes: {
                    "data-testid": "coop-council-member",
                    "data-user-id": member.userId,
                    "data-rank": member.rank,
                  },
                  media: <ChannelAvatar name={member.name} accent={member.accent} size="sm" decorative />,
                  title: member.name,
                  description: member.seat,
                }))}
              />
              <ListPanel
                title="Coming up"
                items={events.map((event) => ({
                  id: event.id,
                  media: (
                    <span className="flex flex-col items-center">
                      <span>{event.month}</span>
                      <span className="tabular-nums">{event.day}</span>
                    </span>
                  ),
                  title: event.title,
                }))}
              />
            </div>
          }
        />
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <CoopPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };
