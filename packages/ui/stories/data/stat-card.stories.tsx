// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Progress } from "../../src/components/progress.tsx";
import { ProgressRow, StatCard, StatGrid } from "../../src/blocks/data/index.ts";

const meta = { title: "Blocks/Data/StatCard", component: StatCard, parameters: { layout: "padded" } } satisfies Meta<
  typeof StatCard
>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <StatGrid cols={4}>
      <StatCard
        label="Monthly recurring revenue"
        value="$12,480"
        delta={{ direction: "up", label: "8% this month", sentiment: "positive" }}
      />
      <StatCard label="Subscribers" value="1,284" hint="Across all tiers" />
      <StatCard size="sm" label="Member since" value="2024" />
    </StatGrid>
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };

/** `footer` under the value: the Revenue board's available-balance progress. */
export const WithFooter: Story = {
  render: () => (
    <StatGrid cols={3}>
      <StatCard
        label="Available balance"
        value="$1,284.60"
        hint="Pays out Nov 1 · minimum $50.00"
        footer={<Progress aria-label="Balance toward the payout minimum" value={100} />}
      />
      <StatCard
        label="Goal this month"
        value="$842.10"
        hint="of $1,200"
        footer={<ProgressRow label="Goal" value={70} valueText="70%" tone="success" />}
      />
    </StatGrid>
  ),
};
export const WithFooterLight: Story = { ...WithFooter, globals: { theme: "light" } };
export const WithFooterMobile320: Story = { ...WithFooter, globals: { viewport: { value: "mobile320" } } };
