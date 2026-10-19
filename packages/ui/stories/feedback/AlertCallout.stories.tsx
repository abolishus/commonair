// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Notification01Icon } from "@hugeicons/core-free-icons";
import { Button } from "../../src/components/button.tsx";
import { AlertCallout } from "../../src/blocks/feedback/index.ts";

const meta = {
  title: "Blocks/Feedback/AlertCallout",
  component: AlertCallout,
  parameters: { layout: "padded" },
} satisfies Meta<typeof AlertCallout>;
export default meta;
type Story = StoryObj;

const Tones = () => (
  <div className="flex flex-col gap-3">
    <AlertCallout description="Past broadcasts are kept 60 days. Highlights and uploads are kept until you delete them." />
    <AlertCallout
      tone="info"
      title="Treasury review"
      description="The finance committee checked the numbers; the full review is linked from the proposal."
    />
    <AlertCallout
      tone="warning"
      title="Your old key showed up in a public paste."
      description="We revoked it automatically on Oct 14. The key below is new."
      action={<a href="#leak-scanner">What the leak scanner checks</a>}
    />
    <AlertCallout
      tone="danger"
      live
      title="Payout failed"
      description="Your bank rejected the transfer. Update your payout method to try again."
    />
  </div>
);

export const Default: Story = { render: () => <Tones /> };
export const Light: Story = { render: () => <Tones />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Tones />, globals: { viewport: { value: "mobile320" } } };

/** Custom icon and a button action (Following board). */
export const WithAction: Story = {
  render: () => (
    <AlertCallout
      icon={Notification01Icon}
      description="Get go-live notifications by email or web push."
      action={
        <Button variant="outline" size="xs">
          Notification settings
        </Button>
      }
    />
  ),
};
/** `icon={null}` for a plain note (ChannelSidebar). */
export const NoIcon: Story = {
  render: () => <AlertCallout icon={null} description="Viewer counts are verified." />,
};
