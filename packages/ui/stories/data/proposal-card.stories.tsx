// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProposalCard } from "../../src/blocks/data/index.ts";

const meta = {
  title: "Blocks/Data/ProposalCard",
  component: ProposalCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProposalCard>;
export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <ProposalCard
        reference="#47"
        title="Lower the creator share of subscriptions from 71% to 65%"
        link={{ href: "#proposal/47" }}
        summary="Fund a second origin region by moving 6 points of every subscription to infrastructure for 12 months."
        status="Voting"
        protectedLabel="Protected"
        progress={{ label: "Ends Oct 24 · 214 comments", value: 38, valueText: "38% turnout", note: "You voted" }}
      />
      <ProposalCard
        reference="#48"
        title="Adopt the community relay program"
        link={{ href: "#proposal/48" }}
        summary="Members can run relays that carry video to nearby viewers."
        status="Discussion"
        statusTone="neutral"
        progress={{ label: "Voting opens Nov 1 · 41 comments", value: 0, valueText: "— turnout" }}
      />
    </div>
  ),
};
/** Title and status only. */
export const Minimal: Story = {
  render: () => <ProposalCard title="Adopt bylaws v2" link={{ href: "#p" }} status="Passed" statusTone="success" />,
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
