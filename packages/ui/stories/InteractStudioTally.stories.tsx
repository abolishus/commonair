// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../src/components/button.tsx";
import { StatusBadge } from "../src/primitives/status-badge.tsx";
import { TallyList, type TallyItem } from "../src/blocks/interact-studio/index.ts";

const meta = { title: "Blocks/InteractStudio/TallyList" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const poll: TallyItem[] = [
  { id: "1", label: "Dust", value: 42, valueText: "42 votes" },
  { id: "2", label: "Mirage", value: 17, valueText: "17 votes" },
  { id: "3", label: "Inferno", value: 3, valueText: "3 votes" },
];

export const Poll: Story = {
  render: () => (
    <div className="max-w-md">
      <TallyList label="Poll results" items={poll} />
    </div>
  ),
};

export const PredictionLocked: Story = {
  render: () => (
    <div className="max-w-md">
      <TallyList
        label="Prediction outcomes"
        items={[
          {
            id: "a",
            label: "Team A",
            value: 1200,
            valueText: "1,200 points · 5 viewers",
            action: (
              <Button size="sm" variant="outline">
                This one won
              </Button>
            ),
          },
          {
            id: "b",
            label: "Team B",
            value: 800,
            valueText: "800 points · 3 viewers",
            action: (
              <Button size="sm" variant="outline">
                This one won
              </Button>
            ),
          },
        ]}
      />
    </div>
  ),
};

export const PredictionResolved: Story = {
  render: () => (
    <div className="max-w-md">
      <TallyList
        label="Prediction outcomes"
        items={[
          {
            id: "a",
            label: "Team A",
            value: 1200,
            valueText: "1,200 points · 5 viewers",
            tone: "success",
            badge: <StatusBadge tone="success">Winner</StatusBadge>,
            note: "Paid out 2,000 points to 5 viewers",
          },
          { id: "b", label: "Team B", value: 800, valueText: "800 points · 3 viewers", note: "Lost" },
        ]}
      />
    </div>
  ),
};

export const NoVotes: Story = {
  render: () => (
    <div className="max-w-md">
      <TallyList label="Poll results" items={poll.map((item) => ({ ...item, value: 0, valueText: "0 votes" }))} />
    </div>
  ),
};
