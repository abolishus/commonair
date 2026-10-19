// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { StreamGrid } from "../../src/blocks/media/stream-grid.tsx";
import type { StreamCard } from "@commonair/contracts/dto";
const streams: StreamCard[] = [
  {
    channel: { id: "c1", slug: "fern", displayName: "Fernsby", avatarUrl: null, accent: "teal" },
    broadcast: {
      id: "b1",
      title: "Building a cozy village",
      category: { id: "g1", slug: "games", name: "Games" },
      startedAt: "2026-10-19T10:00:00Z",
      mature: false,
      viewerCount: 512,
      thumbnailUrl: null,
    },
    tags: ["cozy"],
    language: "en",
    reason: "spotlight",
  },
];
const meta = {
  title: "Blocks/Media/StreamGrid",
  component: StreamGrid,
  args: { streams, hrefFor: (stream) => `/${stream.channel.slug}` },
} satisfies Meta<typeof StreamGrid>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { streams: [], empty: <p>No live channels.</p> } };
