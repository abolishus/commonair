// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { BreakdownBar } from "../../src/blocks/data/index.ts";

const meta = {
  title: "Blocks/Data/BreakdownBar",
  component: BreakdownBar,
  parameters: { layout: "padded" },
} satisfies Meta<typeof BreakdownBar>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <BreakdownBar
      label="Revenue by source"
      segments={[
        { id: "subs", label: "Subscriptions", value: 8200 },
        { id: "tips", label: "Tips", value: 2800 },
        { id: "pledges", label: "Co-op pledges", value: 1480 },
      ]}
      formatLabel={(items, shares) =>
        `Revenue sources: ${items.map((item, index) => `${item.label} ${shares[index]}%`).join(", ")}`
      }
    />
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
