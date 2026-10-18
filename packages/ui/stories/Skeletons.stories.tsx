// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  SkeletonAvatar,
  SkeletonButton,
  SkeletonGroup,
  SkeletonText,
  SkeletonThumbnail,
  StreamCardSkeleton,
} from "../src/index.ts";

const meta = {
  title: "Primitives/Skeletons",
  component: SkeletonGroup,
} satisfies Meta<typeof SkeletonGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const All: Story = {
  render: () => (
    <SkeletonGroup className="flex max-w-md flex-col gap-6">
      <div className="flex items-center gap-3">
        <SkeletonAvatar />
        <SkeletonText lines={2} />
      </div>
      <SkeletonThumbnail />
      <SkeletonText lines={4} />
      <SkeletonButton />
      <StreamCardSkeleton />
    </SkeletonGroup>
  ),
};

export const Light: Story = { ...All, globals: { theme: "light" } };
export const Mobile320: Story = { ...All, globals: { viewport: { value: "mobile320" } } };
