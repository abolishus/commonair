// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Delete02Icon, Notification01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "../src/index.ts";

const meta = {
  title: "Primitives/IconButton",
  component: IconButton,
  args: { label: "Settings", icon: Settings01Icon },
} satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Outline: Story = { args: { variant: "outline" } };
export const Destructive: Story = { args: { label: "Delete", icon: Delete02Icon, variant: "destructive" } };
export const Disabled: Story = { args: { disabled: true } };
export const WithShortcutTooltip: Story = {
  args: { label: "Notifications", tooltip: "Notifications (N)", icon: Notification01Icon },
};
export const LongLabel: Story = {
  args: { label: "Open the notification settings for every channel you follow, including muted ones" },
};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-2">
      {(["icon-xs", "icon-sm", "icon", "icon-lg"] as const).map((size) => (
        <IconButton key={size} {...args} size={size} />
      ))}
    </div>
  ),
};

export const Light: Story = { ...Sizes, globals: { theme: "light" } };
export const RightToLeft: Story = { ...Sizes, globals: { dir: "rtl" } };
