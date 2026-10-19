// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Timeline } from "../../src/blocks/data/index.ts";

const meta = { title: "Blocks/Data/Timeline", component: Timeline, parameters: { layout: "padded" } } satisfies Meta<
  typeof Timeline
>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <Timeline
      steps={[
        { id: "created", label: "Proposal created", meta: "Oct 12", state: "done" },
        { id: "voting", label: "Voting in progress", meta: "Closes in 2 days", state: "current" },
        { id: "decision", label: "Decision published", state: "upcoming" },
      ]}
    />
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
