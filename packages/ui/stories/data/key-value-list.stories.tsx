// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { KeyValueList } from "../../src/blocks/data/index.ts";
import { StatusBadge } from "../../src/primitives/status-badge.tsx";

const meta = {
  title: "Blocks/Data/KeyValueList",
  component: KeyValueList,
  parameters: { layout: "padded" },
} satisfies Meta<typeof KeyValueList>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <KeyValueList
      dense
      rows={[
        { term: "Ingest", value: <StatusBadge tone="success">Operational</StatusBadge> },
        { term: "Bitrate", value: "6.2 Mbps" },
        { term: "Dropped frames", value: "0.02%" },
        { term: "Latency", value: "1.4 s" },
      ]}
    />
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
