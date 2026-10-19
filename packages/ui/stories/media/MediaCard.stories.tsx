// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MediaCard } from "../../src/blocks/media/media-card.tsx";
const meta = {
  title: "Blocks/Media/MediaCard",
  component: MediaCard,
  args: {
    media: {
      id: "vod-1",
      title: "A long-form stream archive",
      channelName: "Fernsby",
      duration: "2:58:12",
      ago: "2 days ago",
      views: "12.5K views",
      kind: "Past broadcast",
      mature: true,
      matureLabel: "Mature",
      highlightLabel: "Highlight",
    },
    href: "/videos/vod-1",
    variant: "vod",
  },
} satisfies Meta<typeof MediaCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const Compact: Story = { args: { layout: "compact", variant: "clip" } };
