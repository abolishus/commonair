// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { OverlayBadge } from "../../src/primitives/overlay-badge.tsx";

const meta = { title: "Primitives/OverlayBadge", component: OverlayBadge } satisfies Meta<typeof OverlayBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Sizes: Story = {
  render: () => (
    <div className="relative aspect-video bg-muted p-3">
      <OverlayBadge size="sm">1.2K viewers</OverlayBadge>
      <OverlayBadge className="absolute end-3 bottom-3">2:34</OverlayBadge>
    </div>
  ),
};
export const Light: Story = { ...Sizes, globals: { theme: "light" } };
export const Mobile320: Story = { ...Sizes, globals: { viewport: { value: "mobile320" } } };
