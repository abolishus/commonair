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

/** v2: a primary and a secondary action. */
export const TwoActions: Story = {
  args: {
    icon: undefined,
    title: "Nobody is live right now",
    description: "Follow channels to hear when they go live, or catch up on videos.",
    action: <Button>Browse videos</Button>,
    secondaryAction: <Button variant="outline">Find channels</Button>,
  },
};
export const Small: Story = { args: { size: "sm", action: undefined } };
export const SmallArcs: Story = {
  args: {
    size: "sm",
    icon: undefined,
    art: "arcs",
    title: "Queue clear",
    description: "New reports show up here.",
    action: undefined,
  },
};
export const Bars: Story = { args: { art: "bars" } };
/** A whole page (404/500): `size="lg"`, the arcs crossed by one bar. */
export const PageNotFound: Story = {
  args: {
    size: "lg",
    icon: undefined,
    crossed: true,
    title: "This page is not on the air",
    description: "The link may be old, or the channel may have moved.",
    action: <Button>Browse live channels</Button>,
    secondaryAction: <Button variant="outline">Try again</Button>,
  },
};
export const PageNotFoundLight: Story = { ...PageNotFound, globals: { theme: "light" } };
export const PageNotFound320: Story = { ...PageNotFound, globals: { viewport: { value: "mobile320" } } };
