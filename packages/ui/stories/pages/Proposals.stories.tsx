// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Add01Icon, File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { EmptyState } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { PageHeader, PageTabs } from "@commonair/ui/blocks/headers";
import { ProposalCard } from "@commonair/ui/blocks/data";
import { ChoiceToggle } from "@commonair/ui/blocks/forms";
import { proposalStatusTone } from "@commonair/ui/blocks/coop";
import { coopTabs } from "./fixtures/CoopNav.ts";
import { proposals, statusFilters, statusLabels, type ProposalListEntry } from "./fixtures/Proposals.ts";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/Proposals", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const OPEN = new Set(["discussion", "council_review", "voting"]);

function ProposalsPage({
  items,
  member = true,
  initialFilter = "all",
}: {
  items: ProposalListEntry[];
  member?: boolean;
  initialFilter?: string;
}): React.JSX.Element {
  const [filter, setFilter] = React.useState(initialFilter);
  const shown = items.filter((item) => filter === "all" || item.status === filter);
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader
          title="Proposals"
          description="Members draft, discuss and vote on how the co-op runs. Protected decisions also need the streamer class."
          tabs={<PageTabs variant="default" items={coopTabs("proposals")} aria-label="Co-op" />}
          actions={
            member ? (
              <Button
                size="sm"
                render={<a href="#coop/proposals/new" aria-label="New proposal" data-testid="proposals-new" />}
                nativeButton={false}
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
                New proposal
              </Button>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-4" data-testid="proposals">
          <ChoiceToggle
            label="Status"
            data-testid="proposals-filter"
            wrap
            options={statusFilters.map((option) => ({
              ...option,
              "data-testid": `proposals-filter-${option.value}`,
            }))}
            value={filter}
            onValueChange={setFilter}
          />
          {shown.length === 0 ? (
            <EmptyState
              data-testid="proposals-empty"
              icon={File01Icon}
              title="No proposals here"
              description={
                filter === "all"
                  ? "Nobody has proposed anything yet. Members can start the first one."
                  : "No proposal has this status right now."
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              {shown.map((item) => (
                <ProposalCard
                  key={item.id}
                  data-testid="proposal-item"
                  data-proposal-id={item.id}
                  data-status={item.status}
                  data-kind={item.kind}
                  reference={`#${item.number}`}
                  title={item.title}
                  link={{ href: `#coop/proposals/${item.id}` }}
                  summary={item.summary}
                  status={statusLabels[item.status] ?? item.status}
                  statusTone={proposalStatusTone(item.status)}
                  protectedLabel={item.kind === "protected" ? "Protected" : undefined}
                  progress={
                    item.participation
                      ? {
                          label: item.meta,
                          value: (item.participation.voted / item.participation.eligible) * 100,
                          valueText: `${Math.round((item.participation.voted / item.participation.eligible) * 100)}% voted`,
                          note: OPEN.has(item.status) ? "Results are published when voting closes." : undefined,
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      </PageContainer>
    </ViewerPage>
  );
}

export const Default: Story = { render: () => <ProposalsPage items={proposals} /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };

/** Signed out or not a member: no "New proposal". */
export const Public: Story = { render: () => <ProposalsPage items={proposals} member={false} /> };

/** No proposal matches the filter. */
export const EmptyFilter: Story = { render: () => <ProposalsPage items={proposals} initialFilter="withdrawn" /> };

/** No proposals at all. */
export const Empty: Story = { render: () => <ProposalsPage items={[]} /> };
