// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ACCENTS } from "@commonair/contracts/shapes";
import { ChannelAvatar, SkeletonAvatar } from "../src/index.ts";
import { LONG_NAME, avatarImage } from "./fixtures.ts";

const meta = {
  title: "Primitives/ChannelAvatar",
  component: ChannelAvatar,
  args: { name: "Pixel Pioneer", accent: "teal", size: "md" },
} satisfies Meta<typeof ChannelAvatar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Fallback: Story = {};
export const WithImage: Story = { args: { src: avatarImage("teal") } };
export const BrokenImage: Story = { args: { src: "data:image/png;base64,broken" } };
export const Live: Story = { args: { live: true, src: avatarImage("red"), accent: "red" } };

const SIZES = ["xs", "sm", "md", "lg", "xl"] as const;

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-end gap-4">
      {SIZES.map((size) => (
        <ChannelAvatar key={size} {...args} size={size} />
      ))}
    </div>
  ),
};

export const AllAccents: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      {ACCENTS.map((accent) => (
        <ChannelAvatar key={accent} name={accent} accent={accent} size="lg" />
      ))}
    </div>
  ),
};

export const AllAccentsLight: Story = { ...AllAccents, globals: { theme: "light" } };

/** Initials from names in many scripts, punctuation-first names, emoji and an empty name. */
export const Initials: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      {["émile", "@carol", "🎮 gamer", "مريم", "山田", "istanbul", "🇺🇦", "", LONG_NAME].map((name, i) => (
        <ChannelAvatar key={i} name={name} accent={ACCENTS[i % ACCENTS.length]} />
      ))}
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      {SIZES.map((size) => (
        <SkeletonAvatar key={size} size={size} />
      ))}
    </div>
  ),
};
