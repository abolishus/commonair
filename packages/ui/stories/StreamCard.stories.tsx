// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tv01Icon } from "@hugeicons/core-free-icons";
import { ACCENTS } from "@commonair/contracts/shapes";
import { Button } from "../src/components/button.tsx";
import { EmptyState, SkeletonGroup, StreamCard, StreamCardSkeleton } from "../src/index.ts";
import { ResponsiveGrid } from "../src/layouts/page-layout.tsx";
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
    <ResponsiveGrid cols={4}>
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
    </ResponsiveGrid>
  ),
};

export const GridLoading: Story = {
  parameters: { fullWidth: true },
  render: () => (
    <SkeletonGroup>
      <ResponsiveGrid cols={4}>
        {Array.from({ length: 8 }, (_, i) => (
          <StreamCardSkeleton key={i} />
        ))}
      </ResponsiveGrid>
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
