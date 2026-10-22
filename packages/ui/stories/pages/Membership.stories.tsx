// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { EmptyState } from "@commonair/ui";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import {
  EligibilityList,
  MembershipList,
  ShareCard,
  ShareInstructions,
  type EligibilityItem,
  type MembershipListItem,
} from "@commonair/ui/blocks/coop";
import { coopTabs } from "./fixtures/CoopNav.ts";
import { eligibility, exitCopy, intro, memberships, notEligible, share } from "./fixtures/Membership.ts";
import { CURRENCY, LOCALE } from "./money.tsx";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/Membership", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

type ShareState = "none" | "pending" | "held";

const shareLabels: Record<ShareState, { status: string; note: string }> = {
  none: { status: "No share", note: "A one-time, refundable share makes you a viewer member." },
  pending: { status: "Waiting for payment", note: "The treasury confirms it when your transfer arrives." },
  held: { status: "Held", note: "Refunded in full if you leave the viewer class." },
};

function withExit(item: Omit<MembershipListItem, "exit">): MembershipListItem {
  const copy = exitCopy[item.memberClass];
  if (item.status !== "active" || !copy) return item;
  return {
    ...item,
    exit: {
      label: "Leave",
      confirmTitle: copy.title,
      confirmDescription: copy.description,
      confirmLabel: "Leave class",
      destructive: true,
      onConfirm: () => undefined,
      triggerProps: { "data-testid": `membership-exit-${item.memberClass}` },
      dialogProps: { "data-testid": "membership-exit-confirm" },
    },
  };
}

function MembershipPage({
  rows,
  classes,
  initialShare,
}: {
  rows: Omit<MembershipListItem, "exit">[];
  classes: EligibilityItem[];
  initialShare: ShareState;
}): React.JSX.Element {
  const [shareState, setShareState] = React.useState<ShareState>(initialShare);
  const labels = shareLabels[shareState];
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6" data-testid="membership">
        <PageHeader
          title="Your membership"
          description={intro}
          tabs={<PageTabs variant="default" items={coopTabs("membership")} aria-label="Co-op" />}
        />
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex flex-col gap-6">
              <Section heading="Memberships">
                <MembershipList
                  label="Your memberships"
                  items={rows.map(withExit)}
                  itemProps={{ "data-testid": "membership-row" }}
                  empty={
                    <EmptyState
                      icon={UserGroupIcon}
                      headingLevel={3}
                      title="You are not a member yet"
                      description="Stream, buy the member share or subscribe to a channel to join."
                    />
                  }
                />
              </Section>
              <Section heading="Eligibility" description="What each class needs right now.">
                <EligibilityList items={classes} itemProps={{ "data-testid": "membership-eligibility" }} />
              </Section>
            </div>
          }
          aside={
            <ShareCard
              data-testid="membership-share"
              title="Member share"
              description="Refundable, one per member."
              status={shareState}
              statusLabel={labels.status}
              amount={{ cents: share.cents, currency: CURRENCY }}
              amountLabel="Share"
              note={labels.note}
              locale={LOCALE}
              buy={
                shareState === "none"
                  ? {
                      label: "Buy the share",
                      onBuy: () => setShareState("pending"),
                      props: { "data-testid": "membership-buy-share" },
                    }
                  : undefined
              }
              instructions={
                shareState === "pending" ? (
                  <ShareInstructions
                    data-testid="membership-share-instructions"
                    title="How to pay"
                    instructions={share.instructions}
                    amount={{ cents: share.cents, currency: CURRENCY }}
                    amountLabel="Amount"
                    reference={share.reference}
                    referenceLabel="Payment reference"
                    copyLabel="Copy"
                    copiedLabel="Reference copied"
                    copyFailedLabel="Could not copy the reference"
                    paymentId={share.paymentId}
                    locale={LOCALE}
                  />
                ) : undefined
              }
            />
          }
        />
      </PageContainer>
    </ViewerPage>
  );
}

/** A streamer who also holds the viewer share. */
export const Default: Story = {
  render: () => <MembershipPage rows={memberships} classes={eligibility} initialShare="held" />,
};
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };

/** Not a member: buy the share (click it to see the manual instructions). */
export const NotMember: Story = {
  render: () => <MembershipPage rows={[]} classes={notEligible} initialShare="none" />,
};

/** After buying: the manual payment instructions with the copyable reference. */
export const SharePending: Story = {
  render: () => <MembershipPage rows={[]} classes={notEligible} initialShare="pending" />,
};
