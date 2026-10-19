// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CategoryTile } from "../../src/blocks/media/category-tile.tsx";
const meta = {
  title: "Blocks/Media/CategoryTile",
  component: CategoryTile,
  args: {
    category: {
      id: "games",
      name: "Games",
      liveCount: 38,
      viewers: 12500,
      accent: "violet",
      tags: ["Co-op", "Strategy"],
    },
    href: "/browse/games",
    liveLabel: (n) => `${n} live`,
    viewerLabel: (n) => `${n} viewers`,
  },
} satisfies Meta<typeof CategoryTile>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const SearchChip: Story = { args: { layout: "chip", size: "sm" } };
