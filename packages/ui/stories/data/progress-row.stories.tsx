// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProgressRow } from "../../src/blocks/data/index.ts";

const meta = {
  title: "Blocks/Data/ProgressRow",
  component: ProgressRow,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProgressRow>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <div className="grid gap-6">
      <ProgressRow label="Monthly goal" value={68} valueText="$6,800 / $10,000" tone="accent" />
      <ProgressRow
        label="Reserve target"
        value={43}
        valueText="$43,000"
        minLabel="$0"
        maxLabel="$100,000"
        tone="success"
      />
    </div>
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
