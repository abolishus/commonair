// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { GridViewIcon } from "@hugeicons/core-free-icons";
import { CategoryGrid, CategoryTile, type CategoryTileData } from "../../src/blocks/media/category-tile.tsx";
import { EmptyState } from "../../src/index.ts";
import { thumbnail } from "../fixtures.ts";

const liveLabel = (n: string) => `${n} live`;
const viewerLabel = (n: string) => `${n} viewers`;

/** Seed-like categories: half with box art, half on the generated fallback (F10). */
const CATEGORIES: CategoryTileData[] = [
  { id: "c1", slug: "art", name: "Art", liveCount: 3, viewers: 41, imageUrl: thumbnail("pink"), tags: ["Creative"] },
  { id: "c2", slug: "music", name: "Music", liveCount: 2, viewers: 18 },
  { id: "c3", slug: "just-chatting", name: "Just Chatting", liveCount: 1, tags: ["IRL", "Talk"] },
  { id: "c4", slug: "software-game-dev", name: "Software & Game Dev", liveCount: 1, viewers: 6 },
  { id: "c5", slug: "food-drink", name: "Food & Drink", liveCount: 0, imageUrl: thumbnail("amber", 1) },
  { id: "c6", slug: "speedrunning", name: "Speedrunning", liveCount: 0 },
  { id: "c7", slug: "hollow-depths", name: "Hollow Depths", liveCount: 0 },
  { id: "c8", slug: "fitness-health", name: "Fitness & Health", liveCount: 0 },
];

const LONG: CategoryTileData = {
  id: "long",
  slug: "a-category-name-that-is-far-too-long",
  name: "A category name that is far too long to fit on one line, or even on two lines of a narrow tile",
  liveCount: 12_400,
  viewers: 1_234_567,
  tags: ["averyveryverylongtagwithoutspaces", "another-long-tag-name"],
};

const DESKTOP = {
  viewport: { options: { desktop1440: { name: "Desktop 1440", styles: { width: "1440px", height: "900px" } } } },
};

const meta = {
  title: "Blocks/Media/CategoryTile",
  component: CategoryTile,
  args: {
    category: CATEGORIES[0] as CategoryTileData,
    href: "/directory/art",
    liveLabel,
    viewerLabel,
  },
  decorators: [
    (Story, context) =>
      context.parameters.fullWidth ? (
        <div className="p-4">
          <Story />
        </div>
      ) : (
        <div className="max-w-48 p-4">
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof CategoryTile>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BoxArt: Story = {};
export const BoxArtLight: Story = { globals: { theme: "light" } };
export const Fallback: Story = { args: { category: CATEGORIES[1] as CategoryTileData } };
export const FallbackLight: Story = {
  args: { category: CATEGORIES[1] as CategoryTileData },
  globals: { theme: "light" },
};
export const FallbackWithTags: Story = { args: { category: CATEGORIES[2] as CategoryTileData } };
export const LongText: Story = { args: { category: LONG } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const SearchChip: Story = { args: { layout: "chip", size: "sm" } };
export const SearchChipFallback: Story = {
  args: { layout: "chip", size: "sm", category: CATEGORIES[3] as CategoryTileData },
};

/** The `/directory` grid: art and fallback side by side, so the tones read as one designed set. */
export const Grid: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <CategoryGrid categories={[...CATEGORIES, LONG]} columns={6} liveLabel={liveLabel} viewerLabel={viewerLabel} />
  ),
};
export const GridLight: Story = { ...Grid, globals: { theme: "light" } };
export const Grid320: Story = { ...Grid, globals: { viewport: { value: "mobile320" } } };
export const Grid1440: Story = {
  ...Grid,
  parameters: { fullWidth: true, ...DESKTOP },
  globals: { viewport: { value: "desktop1440" } },
};
export const GridLoading: Story = {
  parameters: { fullWidth: true },
  render: () => <CategoryGrid categories={[]} loading columns={6} liveLabel={liveLabel} viewerLabel={viewerLabel} />,
};
export const GridEmpty: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <CategoryGrid
      categories={[]}
      liveLabel={liveLabel}
      viewerLabel={viewerLabel}
      empty={<EmptyState icon={GridViewIcon} title="No categories yet" />}
    />
  ),
};

/** 0 live: the art goes muted and no "0 live" badge shows. */
export const Muted: Story = { args: { category: CATEGORIES[6] as CategoryTileData } };
export const MutedLight: Story = { args: { category: CATEGORIES[6] as CategoryTileData }, globals: { theme: "light" } };
/** The compact home shelf: 16:9 art. */
export const Landscape: Story = { args: { shape: "landscape", category: CATEGORIES[1] as CategoryTileData } };
export const LandscapeGrid: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <CategoryGrid
      categories={CATEGORIES}
      columns={4}
      shape="landscape"
      liveLabel={liveLabel}
      viewerLabel={viewerLabel}
    />
  ),
};
export const LandscapeGridLoading: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <CategoryGrid
      categories={[]}
      loading
      columns={4}
      shape="landscape"
      liveLabel={liveLabel}
      viewerLabel={viewerLabel}
    />
  ),
};
