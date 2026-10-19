// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Legend } from "../../src/blocks/data/index.ts";

const meta = { title: "Blocks/Data/Legend", component: Legend, parameters: { layout: "padded" } } satisfies Meta<
  typeof Legend
>;
export default meta;
type Story = StoryObj;

/** Items without `value` are keys only (Status board: the uptime strip's colors). */
export const KeyOnly: Story = {
  render: () => (
    <Legend
      layout="inline"
      aria-label="Legend"
      items={[
        { id: "ok", label: "Operational", color: "--success" },
        { id: "degraded", label: "Degraded", color: "--warning" },
        { id: "outage", label: "Outage", color: "--destructive" },
      ]}
    />
  ),
};
/** Items with values show the value and the largest-remainder share. */
export const WithValues: Story = {
  render: () => (
    <Legend
      items={[
        { id: "subs", label: "Subscriptions", value: 8200 },
        { id: "tips", label: "Tips", value: 2800 },
        { id: "pledges", label: "Co-op pledges", value: 1480 },
      ]}
    />
  ),
};
export const Light: Story = { ...KeyOnly, globals: { theme: "light" } };
export const Mobile320: Story = { ...WithValues, globals: { viewport: { value: "mobile320" } } };
