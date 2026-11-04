// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon, Flag01Icon, MoreHorizontalIcon, Share08Icon } from "@hugeicons/core-free-icons";
import { ChannelHeader } from "../../src/blocks/media/channel-header.tsx";
import { Button } from "../../src/components/button.tsx";
import { AccentButton } from "../../src/primitives/accent-button.tsx";
import { IconButton } from "../../src/primitives/icon-button.tsx";
import { SkeletonAvatar, SkeletonGroup, SkeletonText } from "../../src/primitives/skeletons.tsx";
import { StatusBadge } from "../../src/primitives/status-badge.tsx";

/** Viewports beyond the preview's (320, 390, tablet): the channel page's 375 px phone and a 1440 px desktop. */
const viewports = {
  viewport: {
    options: {
      mobile375: { name: "Mobile 375", styles: { width: "375px", height: "812px" }, type: "mobile" },
      desktop1440: { name: "Desktop 1440", styles: { width: "1440px", height: "900px" }, type: "desktop" },
    },
  },
};

/** The channel page's actions: Follow, Support, Share, Report (desktop) and the phone "More" menu. */
const pageActions = (
  <>
    <AccentButton accent="teal">Follow</AccentButton>
    <Button variant="outline" size="sm">
      Support
    </Button>
    <IconButton variant="outline" size="icon-sm" icon={Share08Icon} label="Share" />
    <Button variant="outline" size="sm" className="hidden sm:inline-flex">
      <HugeiconsIcon icon={Flag01Icon} strokeWidth={2} aria-hidden />
      Report
    </Button>
    <IconButton variant="outline" size="icon-sm" icon={MoreHorizontalIcon} label="More actions" className="sm:hidden" />
  </>
);

const uptime = (
  <span className="inline-flex items-center gap-1 tabular-nums">
    <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} aria-hidden className="size-3.5" />
    2:14:09
  </span>
);

const longText = {
  name: "Wilhelmina_Featherstonehaugh_Productions",
  title:
    "Twelve-hour charity speedrun marathon: every level, every secret, no deaths, all donations go to the local animal shelter",
  category: <span className="font-medium text-foreground underline-offset-4">Retro Platformers and Speedrunning</span>,
  tags: ["speedrun", "charity", "english", "no-commentary-until-midnight"],
  tagsLabel: "Tags",
  uptime,
  actions: pageActions,
};

const meta = {
  title: "Blocks/Media/ChannelHeader",
  component: ChannelHeader,
  parameters: viewports,
  args: {
    name: "Fernsby",
    accent: "teal",
    live: true,
    title: "Building a cozy village",
    viewerCount: 15300,
    offlineLabel: "Offline",
    actions: <AccentButton accent="teal">Follow</AccentButton>,
  },
  decorators: [
    (Story) => (
      <div className="px-4 py-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChannelHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const Offline: Story = { args: { live: false, variant: "offline", title: "Usually live evenings" } };

/** Live metadata (F9): category, tags, uptime, Share and the overflow menu. */
export const LiveMetadata: Story = {
  args: {
    category: <span className="font-medium text-foreground">Art</span>,
    tags: ["cozy", "watercolor"],
    tagsLabel: "Tags",
    uptime,
    actions: pageActions,
  },
};
/** Below the verified-viewer threshold (F12): "Just started" beside the live badge, no eye and no 0. */
export const JustStarted: Story = {
  args: {
    viewerCount: undefined,
    badges: <StatusBadge tone="neutral">Just started</StatusBadge>,
    uptime,
    actions: pageActions,
  },
};

/** F4: at 320 px the actions wrap onto their own row and the name and title stay readable. */
export const LongText320: Story = { args: longText, globals: { viewport: { value: "mobile320" } } };
export const LongText320Light: Story = {
  args: longText,
  globals: { viewport: { value: "mobile320" }, theme: "light" },
};
export const LongText375: Story = { args: longText, globals: { viewport: { value: "mobile375" } } };
export const LongText375Light: Story = {
  args: longText,
  globals: { viewport: { value: "mobile375" }, theme: "light" },
};
export const LongText1440: Story = { args: longText, globals: { viewport: { value: "desktop1440" } } };
export const LongText1440Light: Story = {
  args: longText,
  globals: { viewport: { value: "desktop1440" }, theme: "light" },
};

/** The least a header can carry: a name only. */
export const Empty: Story = {
  args: { live: false, variant: "offline", title: undefined, viewerCount: undefined, actions: undefined },
};
export const Empty320: Story = { ...Empty, globals: { viewport: { value: "mobile320" } } };

/** The page's frame while the channel loads (the header has no loading state of its own). */
export const Loading: Story = {
  render: () => (
    <SkeletonGroup label="Loading the channel" className="flex items-center gap-3">
      <SkeletonAvatar size="lg" />
      <SkeletonText lines={2} className="max-w-80" />
    </SkeletonGroup>
  ),
};

/** The header scopes the channel's accent: the avatar fallback and an un-accented AccentButton follow it. */
export const Accents: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      {(["teal", "orange", "violet", "zinc"] as const).map((accent) => (
        <ChannelHeader
          key={accent}
          {...args}
          name={`Fernsby (${accent})`}
          accent={accent}
          actions={<AccentButton>Support</AccentButton>}
        />
      ))}
    </div>
  ),
};
export const AccentsLight: Story = { ...Accents, globals: { theme: "light" } };
