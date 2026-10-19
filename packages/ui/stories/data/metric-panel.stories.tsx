// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MetricPanel } from "../../src/blocks/data/index.ts";

const meta = {
  title: "Blocks/Data/MetricPanel",
  component: MetricPanel,
  parameters: { layout: "padded" },
} satisfies Meta<typeof MetricPanel>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <div className="grid gap-3 md:grid-cols-3">
      <MetricPanel
        title="Integrity"
        value="99.98%"
        caption="Receipts verified"
        body="All recent stream receipts passed verification."
      />
      <MetricPanel title="Relays" value="18" caption="Healthy relays" body="Serving members across 6 regions." />
      <MetricPanel
        title="Trust & Safety"
        value="4"
        caption="Reports in queue"
        body="Oldest report received 2 hours ago."
      />
    </div>
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
