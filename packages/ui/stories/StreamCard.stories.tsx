// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tv01Icon } from "@hugeicons/core-free-icons";
import { ACCENTS } from "@commonair/contracts/shapes";
import { Button } from "../src/components/button.tsx";
import {
  ChannelChip,
  ChannelChipRow,
  ChannelChipSkeleton,
  EmptyState,
  SkeletonGroup,
  StreamCard,
  StreamCardSkeleton,
} from "../src/index.ts";
import { CardGrid } from "../src/blocks/media/stream-grid.tsx";
import { LONG_NAME, LONG_TITLE, makeStream } from "./fixtures.ts";

const meta = {
  title: "Primitives/StreamCard",
  component: StreamCard,
  args: { stream: makeStream(), href: "#pixel_pioneer" },
  decorators: [
    // Single cards render at a typical grid-cell width; grid stories opt out with `parameters.fullWidth`.
    (Story, context) =>
      context.parameters.fullWidth ? (
        <Story />
      ) : (
        <div className="max-w-xs">
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof StreamCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Light: Story = { globals: { theme: "light" } };

export const LongText: Story = {
  args: {
    stream: makeStream({
      title: LONG_TITLE,
      displayName: LONG_NAME,
      category: "A category name that is also far too long to fit",
      tags: ["averyveryverylongtagwithoutspaces", "another-long-tag-name", "x"],
    }),
  },
};

export const RightToLeft: Story = {
  globals: { dir: "rtl", locale: "ar" },
  args: {
    stream: makeStream({
      title: "بث مباشر طويل جدا لاختبار القص الصحيح للنص من اليمين إلى اليسار في البطاقة",
      displayName: "قناة الألعاب",
      category: "ألعاب",
      tags: ["عربي", "مباشر"],
      language: "ar",
      reason: "new",
    }),
  },
};

export const Mobile320: Story = {
  globals: { viewport: { value: "mobile320" } },
  parameters: { fullWidth: true },
  args: { stream: makeStream({ title: LONG_TITLE, displayName: LONG_NAME }) },
};

export const NoThumbnailNoAvatar: Story = {
  args: { stream: makeStream({ thumbnail: null, avatar: false, accent: "violet", reason: "random" }) },
};

/** The thumbnail fails to load: the card falls back to the accent placeholder. */
export const BrokenThumbnail: Story = {
  args: { stream: makeStream({ thumbnail: "data:image/png;base64,broken", accent: "amber" }) },
};

/** `uptimeLabel`: time live over the thumbnail's bottom-end corner (Following board). */
export const WithUptime: Story = { args: { uptimeLabel: "3:41:09" } };
export const WithUptimeLight: Story = { args: { uptimeLabel: "3:41:09" }, globals: { theme: "light" } };
export const WithUptimeMobile320: Story = {
  args: { uptimeLabel: "3:41:09" },
  globals: { viewport: { value: "mobile320" } },
};
export const Mature: Story = { args: { stream: makeStream({ mature: true, reason: "category" }) } };

export const NoCategoryNoTags: Story = {
  args: { stream: makeStream({ category: null, tags: [] }), showReason: false },
};

/** Link slots: the category and each tag are their own links above the stretched channel link. */
const slotArgs = {
  categoryLink: { href: "#category" },
  tagLink: (tag: string) => ({ href: `#tag-${tag}` }),
};
export const WithLinkSlots: Story = { args: slotArgs };
export const WithLinkSlotsLight: Story = { args: slotArgs, globals: { theme: "light" } };
export const WithLinkSlotsMobile320: Story = {
  args: { ...slotArgs, stream: makeStream({ title: LONG_TITLE, displayName: LONG_NAME }) },
  globals: { viewport: { value: "mobile320" } },
};
/** `channelLink` too, for a card whose primary link is the watch page rather than the channel. */
export const WithChannelLinkSlot: Story = {
  args: { ...slotArgs, href: "#watch", channelLink: { href: "#pixel_pioneer" } },
};

export const Loading: Story = {
  render: () => (
    <SkeletonGroup>
      <StreamCardSkeleton />
    </SkeletonGroup>
  ),
};

export const Grid: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <CardGrid>
      {ACCENTS.map((accent, i) => (
        <StreamCard
          key={accent}
          href={`#${accent}`}
          stream={makeStream({
            accent,
            displayName: `${accent[0]!.toUpperCase()}${accent.slice(1)} Channel`,
            viewers: [3, 87, 999, 1_240, 15_300, 230_000, 1_500_000][i % 7],
            reason: (["popular", "spotlight", "new", "following", "random", "category", "search"] as const)[i % 7],
          })}
        />
      ))}
    </CardGrid>
  ),
};

export const GridLoading: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <SkeletonGroup>
      <CardGrid>
        {Array.from({ length: 8 }, (_, i) => (
          <StreamCardSkeleton key={i} />
        ))}
      </CardGrid>
    </SkeletonGroup>
  ),
};

export const GridEmpty: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <EmptyState
      icon={Tv01Icon}
      title="Nobody is live in this category"
      description="Follow channels to hear when they go live, or browse another category."
      action={<Button variant="outline">Browse categories</Button>}
    />
  ),
};

/** `size="feature"`: the home hero card, 62/38 from 768 px, stacked below. A poster, never autoplay. */
const featureArgs = { size: "feature" as const, ctaLabel: "Watch now", lazy: false, uptimeLabel: "1:12:09" };
export const Feature: Story = { parameters: { fullWidth: true }, args: featureArgs };
export const FeatureLight: Story = { parameters: { fullWidth: true }, args: featureArgs, globals: { theme: "light" } };
export const FeatureMobile320: Story = {
  parameters: { fullWidth: true },
  args: { ...featureArgs, stream: makeStream({ title: LONG_TITLE, displayName: LONG_NAME }) },
  globals: { viewport: { value: "mobile320" } },
};
export const FeatureNoThumbnail: Story = {
  parameters: { fullWidth: true },
  args: { ...featureArgs, stream: makeStream({ thumbnail: null, accent: "violet" }) },
};
export const FeatureLoading: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <SkeletonGroup>
      <StreamCardSkeleton size="feature" />
    </SkeletonGroup>
  ),
};

const OFFLINE = [
  { name: "Mika Draws", accent: "pink", meta: "Art · 3 hours ago" },
  { name: "Basement Synths", accent: "sky", meta: "Music · 5 hours ago" },
  { name: "Ferro Builds", accent: "zinc", meta: "Making · Yesterday" },
  { name: "Studio Okra", accent: "green", meta: "Cooking · Yesterday" },
  { name: "Polyglot Pete", accent: "indigo", meta: "Languages · 2 days ago" },
  { name: "A channel name that is far too long for a chip", accent: "violet", meta: "Talk · 2 days ago" },
] as const;

/** `ChannelChip` rows for offline channels: a scroller below 768 px, wrapping above. */
export const ChannelChips: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <ChannelChipRow aria-label="Recently live">
      {OFFLINE.map((c) => (
        <ChannelChip key={c.name} name={c.name} accent={c.accent} meta={c.meta} href={`#${c.accent}`} />
      ))}
    </ChannelChipRow>
  ),
};
export const ChannelChipsLight: Story = { ...ChannelChips, globals: { theme: "light" } };
export const ChannelChipsMobile320: Story = { ...ChannelChips, globals: { viewport: { value: "mobile320" } } };
export const ChannelChipsLoading: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <SkeletonGroup className="flex gap-2">
      <ChannelChipSkeleton />
      <ChannelChipSkeleton />
      <ChannelChipSkeleton />
    </SkeletonGroup>
  ),
};
