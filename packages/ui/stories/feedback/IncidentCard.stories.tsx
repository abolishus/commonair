// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { IncidentCard } from "../../src/blocks/feedback/index.ts";

const meta = {
  title: "Blocks/Feedback/IncidentCard",
  component: IncidentCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof IncidentCard>;
export default meta;
type Story = StoryObj;

const Incidents = () => (
  <div className="flex flex-col gap-3">
    <IncidentCard
      status="Monitoring"
      title="Chat delivery delays in EU"
      date="Oct 18"
      updates={[
        {
          id: "u3",
          status: "Monitoring",
          time: "19:12 UTC",
          text: "A Valkey replica was failed over. Delays are falling; we are watching for 30 minutes.",
          tone: "warning",
        },
        { id: "u2", status: "Identified", time: "18:54 UTC", text: "Fan-out lag on one chat node.", tone: "info" },
        { id: "u1", status: "Investigating", time: "18:41 UTC", text: "Reports of chat arriving late." },
      ]}
    />
    <IncidentCard
      status="Resolved"
      tone="success"
      title="Origin outage, all regions (46 min)"
      date="Aug 22"
      note="Storage quota exhausted on the origin cache. Relays kept 31% of viewers watching."
      link={{ label: "Postmortem", href: "#postmortem" }}
    />
  </div>
);

export const Default: Story = { render: () => <Incidents /> };
export const Light: Story = { render: () => <Incidents />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Incidents />, globals: { viewport: { value: "mobile320" } } };
