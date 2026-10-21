// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DeadlineCountdown } from "../../src/blocks/feedback/index.ts";

const meta = {
  title: "Blocks/Feedback/DeadlineCountdown",
  component: DeadlineCountdown,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DeadlineCountdown>;
export default meta;
type Story = StoryObj;

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const HOUR = 3_600_000;

const States = () => (
  <div className="flex flex-col items-start gap-3">
    <DeadlineCountdown deadline={NOW + 40 * HOUR} now={NOW} dueLabel="Due" overdueLabel="Overdue" />
    <DeadlineCountdown
      deadline={NOW + 10 * 60_000}
      now={NOW}
      warnWithinMs={HOUR}
      dueLabel="SLA"
      overdueLabel="SLA missed"
    />
    <DeadlineCountdown deadline={NOW - 2 * HOUR} now={NOW} dueLabel="Due" overdueLabel="Overdue" />
  </div>
);

export const Default: Story = { render: () => <States /> };
export const Light: Story = { render: () => <States />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <States />, globals: { viewport: { value: "mobile320" } } };
