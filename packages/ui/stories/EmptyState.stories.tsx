// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Alert02Icon, InboxIcon } from "@hugeicons/core-free-icons";
import { Button } from "../src/components/button.tsx";
import { EmptyState } from "../src/index.ts";
import { LONG_TITLE } from "./fixtures.ts";

const meta = {
  title: "Primitives/EmptyState",
  component: EmptyState,
  args: {
    icon: InboxIcon,
    title: "No clips yet",
    description: "Clips you make from live streams appear here.",
    action: <Button>Make your first clip</Button>,
  },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const TitleOnly: Story = { args: { icon: undefined, description: undefined, action: undefined } };
export const ErrorState: Story = {
  args: {
    icon: Alert02Icon,
    title: "Could not load clips",
    description: "Check your connection and try again.",
    action: <Button variant="outline">Retry</Button>,
  },
};
export const LongText: Story = { args: { title: LONG_TITLE, description: `${LONG_TITLE}. ${LONG_TITLE}.` } };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const RightToLeft: Story = {
  globals: { dir: "rtl" },
  args: { title: "لا توجد مقاطع بعد", description: "ستظهر هنا المقاطع التي تنشئها من البث المباشر." },
};
