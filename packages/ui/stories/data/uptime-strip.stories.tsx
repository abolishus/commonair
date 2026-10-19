// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { UptimeStrip } from "../../src/blocks/data/index.ts";

const meta = {
  title: "Blocks/Data/UptimeStrip",
  component: UptimeStrip,
  parameters: { layout: "padded" },
} satisfies Meta<typeof UptimeStrip>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <UptimeStrip
      label="90 day service uptime"
      days={Array.from({ length: 90 }, (_, i) => ({
        id: String(i),
        date: `Day ${i + 1}`,
        status: (i === 40 ? "outage" : i === 56 ? "degraded" : "ok") as "ok" | "outage" | "degraded",
      }))}
      statusLabels={{ ok: "Operational", degraded: "Degraded", outage: "Outage", none: "No data" }}
    />
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
