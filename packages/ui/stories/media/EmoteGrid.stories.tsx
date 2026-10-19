// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmoteGrid } from "../../src/blocks/media/emote-grid.tsx";
const meta = {
  title: "Blocks/Media/EmoteGrid",
  component: EmoteGrid,
  args: {
    emotes: [
      { id: "fern", label: "Fern", glyph: "🌿", accent: "teal" },
      { id: "star", label: "Star", glyph: "✦", accent: "violet" },
    ],
  },
} satisfies Meta<typeof EmoteGrid>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
