// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { LiveBadge, ViewerCount } from "../src/index.ts";

const meta = {
  title: "Primitives/LiveBadge and ViewerCount",
  component: LiveBadge,
} satisfies Meta<typeof LiveBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {};
export const Pulsing: Story = { args: { pulse: true } };
export const Small: Story = { args: { size: "sm" } };
export const Translated: Story = { args: { label: "En direct" } };
export const Light: Story = { args: { pulse: true }, globals: { theme: "light" } };

const COUNTS = [0, 1, 42, 999, 1_000, 1_234, 15_300, 230_000, 1_500_000, 2_000_000_000];

export const ViewerCounts: Story = {
  render: () => (
    <ul className="flex flex-col gap-2">
      {COUNTS.map((count) => (
        <li key={count} className="flex items-center gap-4">
          <ViewerCount count={count} />
          <span className="relative inline-flex h-10 w-40 items-end bg-muted p-1">
            <ViewerCount count={count} variant="overlay" size="sm" />
          </span>
        </li>
      ))}
    </ul>
  ),
};

export const ViewerCountsGerman: Story = { ...ViewerCounts, globals: { locale: "de" } };
export const ViewerCountsJapanese: Story = { ...ViewerCounts, globals: { locale: "ja" } };
export const ViewerCountsLight: Story = { ...ViewerCounts, globals: { theme: "light" } };
