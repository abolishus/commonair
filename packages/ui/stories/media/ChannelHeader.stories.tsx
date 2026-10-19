// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChannelHeader } from "../../src/blocks/media/channel-header.tsx";
import { AccentButton } from "../../src/primitives/accent-button.tsx";
const meta = {
  title: "Blocks/Media/ChannelHeader",
  component: ChannelHeader,
  args: {
    name: "Fernsby",
    accent: "teal",
    live: true,
    title: "Building a cozy village",
    viewerCount: 15300,
    offlineLabel: "Offline",
    actions: <AccentButton accent="teal">Follow</AccentButton>,
  },
} satisfies Meta<typeof ChannelHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const Offline: Story = { args: { live: false, variant: "offline", title: "Usually live evenings" } };
