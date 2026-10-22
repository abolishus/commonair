// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { EmptyState, StatusBadge, formatNumber } from "@commonair/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer, ResponsiveGrid, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { ElectionCard, SeatList } from "@commonair/ui/blocks/coop";
import { coopTabs } from "./fixtures/CoopNav.ts";
import { boardSeats, councilMembers, elections, method, term } from "./fixtures/Council.ts";
import { LOCALE } from "./money.tsx";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/Council", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

function CouncilPage({ seated = true }: { seated?: boolean }): React.JSX.Element {
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer
        width="wide"
        className="flex flex-col gap-6 py-6"
        data-testid="council"
        data-term-id={seated ? term.id : ""}
        data-starts-at={seated ? term.startsAt : ""}
        data-ends-at={seated ? term.endsAt : ""}
      >
        <PageHeader
          title="Creator council and board"
          description="The creator council reviews every proposal that affects creators before members vote. It is seated monthly from streamer members by contribution."
          tabs={<PageTabs variant="default" items={coopTabs("council")} aria-label="Co-op" />}
        />
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex flex-col gap-6">
              <Section heading="Creator council" description={seated ? term.label : undefined}>
                <SeatList
                  label="Creator council"
                  itemProps={{ "data-testid": "council-member" }}
                  items={
                    seated
                      ? councilMembers.map((member) => ({
                          ...member,
                          link: { href: `#${member.name}` },
                          description: `Rank ${member.rank} · score ${formatNumber(member.score, LOCALE)}`,
                          trailing: member.rank === 1 ? <StatusBadge tone="accent">Chair</StatusBadge> : undefined,
                        }))
                      : []
                  }
                  empty={
                    <EmptyState
                      icon={UserGroupIcon}
                      headingLevel={3}
                      title="No council seated yet"
                      description="The council is seated once streamer members qualify; the daily recompute fills it."
                    />
                  }
                />
              </Section>
              <Section heading="Board elections" description="Read-only here; members vote from their notifications.">
                <ResponsiveGrid cols={2}>
                  {elections.map((election) => (
                    <ElectionCard
                      key={election.id}
                      data-testid="election-item"
                      electionId={election.id}
                      memberClass={election.memberClass}
                      status={election.status}
                      statusLabel={election.statusLabel}
                      title={election.title}
                      details={election.details}
                      candidates={election.candidates}
                      labels={{ candidates: "Candidates", elected: "Elected", noCandidates: "No candidates yet." }}
                    />
                  ))}
                </ResponsiveGrid>
              </Section>
            </div>
          }
          aside={
            <div className="flex flex-col gap-4">
              <Card size="sm">
                <CardHeader>
                  <CardTitle>How the council is seated</CardTitle>
                  <CardDescription>
                    Recomputed daily; a new term starts each month or when a seat empties.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <KeyValueList data-testid="council-method" rows={method} />
                </CardContent>
              </Card>
              <Card size="sm">
                <CardHeader>
                  <CardTitle>Board of directors</CardTitle>
                  <CardDescription>One seat per class, elected by that class.</CardDescription>
                </CardHeader>
                <CardContent>
                  <SeatList
                    label="Board of directors"
                    itemProps={{ "data-testid": "board-seat" }}
                    items={boardSeats.map((seat) => ({ ...seat, description: seat.seat }))}
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

export const Default: Story = { render: () => <CouncilPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };

/** Before the first recompute: no term, no seats. */
export const NotSeated: Story = { render: () => <CouncilPage seated={false} /> };
