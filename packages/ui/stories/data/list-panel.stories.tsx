// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ListPanel } from "../../src/blocks/data/index.ts";

const meta = { title: "Blocks/Data/ListPanel", component: ListPanel, parameters: { layout: "padded" } } satisfies Meta<
  typeof ListPanel
>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <ListPanel
      title="Recent activity"
      items={[
        {
          id: "one",
          title: "Pixel Pioneer started streaming",
          description: "Retro speedrunning",
          meta: "5 minutes ago",
          href: "/channels/pixel-pioneer",
        },
        { id: "two", title: "Proposal approved", description: "Community funding round", meta: "Yesterday" },
      ]}
    />
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
