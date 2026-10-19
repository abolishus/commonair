// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PollCard } from "../../src/blocks/data/index.ts";

const meta = { title: "Blocks/Data/PollCard", component: PollCard, parameters: { layout: "padded" } } satisfies Meta<
  typeof PollCard
>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <PollCard
      question="What should we play next?"
      timeLeft="2 hours left"
      totalVotes="1,284 votes"
      voted
      options={[
        { id: "a", label: "Retro", value: 644, percent: 50 },
        { id: "b", label: "Puzzle", value: 390, percent: 30 },
        { id: "c", label: "Co-op", value: 250, percent: 20 },
      ]}
    />
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
