// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatCard, StatGrid } from "../../src/blocks/data/index.ts";

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
