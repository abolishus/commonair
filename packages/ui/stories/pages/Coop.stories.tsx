// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SquareLock01Icon } from "@hugeicons/core-free-icons";
import { ChannelAvatar, StatusBadge, formatNumber } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@commonair/ui/components/card";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import { BreakdownBar, ListPanel, ProgressRow, StatCard, StatGrid } from "@commonair/ui/blocks/data";
import { council, events, intro, membersByClass, membership, proposals, protectedNote, tabs } from "./fixtures/Coop.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/Coop", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function CoopPage(): React.JSX.Element {
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader title="The co-op" description={intro} tabs={<PageTabs variant="default" items={tabs} />} />
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex flex-col gap-6">
              <Card data-accent={membership.accent}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ChannelAvatar name={membership.name} accent={membership.accent} size="md" decorative />
                    Your membership
                  </CardTitle>
                  <CardDescription>{membership.since}</CardDescription>
                  <CardAction>
                    <StatusBadge tone="success">{membership.standing}</StatusBadge>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <StatGrid cols={4}>
                    {membership.stats.map((stat) => (
                      <StatCard key={stat.label} size="sm" label={stat.label} value={stat.value} hint={stat.hint} />
                    ))}
                  </StatGrid>
                </CardContent>
              </Card>
              <Section
                heading="Open for voting"
                action={
                  <Button variant="ghost" size="xs" render={<a href="#coop/proposals" />} nativeButton={false}>
                    All proposals
                  </Button>
                }
              >
                <div className="flex flex-col gap-3">
                  {proposals.map((proposal) => (
                    <Card key={proposal.number} size="sm">
                      <CardHeader>
                        <CardTitle className="flex flex-wrap items-center gap-2">
                          <a href={`#proposal/${proposal.number}`}>
                            #{proposal.number} {proposal.title}
                          </a>
                          {proposal.protected ? (
                            <StatusBadge tone="warning" icon={SquareLock01Icon}>
                              Protected
                            </StatusBadge>
                          ) : null}
                        </CardTitle>
                        <CardDescription>{proposal.summary}</CardDescription>
                        <CardAction>
                          <StatusBadge tone={proposal.tone}>{proposal.status}</StatusBadge>
                        </CardAction>
                      </CardHeader>
                      <CardContent>
                        <ProgressRow
                          label={`${proposal.ends} · ${proposal.comments} comments`}
                          value={proposal.turnout ?? 0}
                          valueText={proposal.turnout === null ? "— turnout" : `${proposal.turnout}% turnout`}
                          note={proposal.voted ? "You voted" : undefined}
                        />
                      </CardContent>
                    </Card>
                  ))}
                </div>
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
                  id: member.name,
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
