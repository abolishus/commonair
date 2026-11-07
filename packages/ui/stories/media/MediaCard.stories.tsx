// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MediaCard, MediaGrid, type MediaCardData } from "../../src/blocks/media/media-card.tsx";
import { SkeletonGroup } from "../../src/index.ts";
import { LONG_TITLE, thumbnail } from "../fixtures.ts";

const VODS: MediaCardData[] = [
  {
    id: "v1",
    title: "Blind run, part 3: the ice level",
    channelName: "Quarter Pixel",
    accent: "pink",
    thumbnailUrl: thumbnail("pink"),
    duration: "2:14:08",
    ago: "Yesterday",
    views: "312 views",
    kind: "Video",
  },
  {
    id: "v2",
    title: "Tiny database part 5: B-trees by hand",
    channelName: "Noor Codes",
    accent: "green",
    thumbnailUrl: thumbnail("green", 1),
    duration: "1:48:30",
    ago: "2 days ago",
    views: "188 views",
    kind: "Video",
  },
  {
    id: "v3",
    title: "Rules night: how council votes work",
    channelName: "Sly Kettle",
    accent: "blue",
    duration: "1:12:30",
    ago: "Last week",
    views: "122 views",
    kind: "Video",
  },
  {
    id: "v4",
    title: LONG_TITLE,
    channelName: "Kitchen Table",
    accent: "orange",
    thumbnailUrl: thumbnail("orange", 2),
    duration: "58:12",
    ago: "3 days ago",
    views: "96 views",
    kind: "Video",
    mature: true,
    matureLabel: "Mature",
  },
];
const CLIPS: MediaCardData[] = [
  {
    id: "c1",
    title: "The jump nobody thought would work",
    channelName: "Quarter Pixel",
    accent: "pink",
    thumbnailUrl: thumbnail("pink", 3),
    duration: "0:28",
    views: "1,240 views",
    ago: "2 days ago",
    kind: "Clip",
  },
  {
    id: "c2",
    title: "Viewer finds the only drawing move",
    channelName: "Endgame Club",
    accent: "blue",
    duration: "0:41",
    clippedBy: "Clipped by Rosa",
    ago: "3 days ago",
    kind: "Clip",
  },
  {
    id: "c3",
    title: "Tape loop finally clicks",
    channelName: "Lumen Beats",
    accent: "sky",
    thumbnailUrl: thumbnail("sky", 1),
    duration: "0:19",
    views: "512 views",
    ago: "Yesterday",
    kind: "Clip",
  },
];

const meta = {
  title: "Blocks/Media/MediaCard",
  component: MediaCard,
  args: { media: VODS[0] as MediaCardData, href: "/videos/v1", kind: "vod" },
  decorators: [
    (Story, context) =>
      context.parameters.fullWidth ? (
        <Story />
      ) : (
        <div className="max-w-xs">
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof MediaCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const Clip: Story = { args: { media: CLIPS[0] as MediaCardData, kind: "clip" } };
/** No thumbnail: the accent field with the arcs, never a grey slab. */
export const NoThumbnail: Story = { args: { media: VODS[2] as MediaCardData } };
export const NoThumbnailLight: Story = { args: { media: VODS[2] as MediaCardData }, globals: { theme: "light" } };
export const Compact: Story = { args: { layout: "compact", kind: "clip", media: CLIPS[1] as MediaCardData } };
/** Legacy `variant` prop, still honoured. */
export const Highlight: Story = {
  args: { variant: "highlight", media: { ...(VODS[1] as MediaCardData), highlightLabel: "Highlight" } },
};

/** "Catch up" and "Fresh clips": the auto-fill grid at a 248 px minimum. */
export const VideoGrid: Story = {
  parameters: { fullWidth: true },
  render: () => <MediaGrid media={VODS} kind="vod" hrefFor={(m) => `#${m.id}`} />,
};
export const ClipGrid: Story = {
  parameters: { fullWidth: true },
  render: () => <MediaGrid media={CLIPS} kind="clip" hrefFor={(m) => `#${m.id}`} />,
};
export const GridLight: Story = { ...VideoGrid, globals: { theme: "light" } };
export const Grid320: Story = { ...VideoGrid, globals: { viewport: { value: "mobile320" } } };
export const GridLoading: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <SkeletonGroup>
      <MediaGrid media={[]} loading loadingCount={4} />
    </SkeletonGroup>
  ),
};
