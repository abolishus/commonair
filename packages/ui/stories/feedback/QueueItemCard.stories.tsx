// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueueItemCard } from "../../src/blocks/feedback/index.ts";
import { ChatMessage } from "../../src/blocks/media/index.ts";

const meta = {
  title: "Blocks/Feedback/QueueItemCard",
  component: QueueItemCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof QueueItemCard>;
export default meta;
type Story = StoryObj;

const Queue = () => (
  <div className="flex flex-col gap-3">
    <QueueItemCard
      kind="Held by filter"
      reason="Link from a new account"
      time="12 s ago"
      actions={[
        { id: "allow", label: "Allow", variant: "default" },
        { id: "deny", label: "Deny" },
        { id: "timeout", label: "Timeout 10 min" },
        { id: "ban", label: "Ban", variant: "destructive" },
      ]}
      trailingAction={{ id: "escalate", label: "Escalate to platform", variant: "ghost" }}
    >
      <ChatMessage author="spamcannon_77" colorIndex={2} body="cheap followers at [link]" />
    </QueueItemCard>
    <QueueItemCard
      kind="Reported"
      tone="danger"
      reason="Harassment, 3 reports"
      time="2 min ago"
      actions={[
        { id: "remove", label: "Remove message", variant: "default" },
        { id: "dismiss", label: "Dismiss" },
      ]}
    >
      <ChatMessage author="grumblebee" colorIndex={5} body="[message hidden until reviewed]" />
    </QueueItemCard>
  </div>
);

export const Default: Story = { render: () => <Queue /> };
export const Light: Story = { render: () => <Queue />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Queue />, globals: { viewport: { value: "mobile320" } } };
