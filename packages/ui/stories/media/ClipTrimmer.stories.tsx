// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClipTrimmer } from "../../src/blocks/media/clip-trimmer.tsx";
const meta = {
  title: "Blocks/Media/ClipTrimmer",
  component: ClipTrimmer,
  args: {
    value: [27, 57],
    onValueChange: () => {},
    duration: 180,
    minDuration: 5,
    maxDuration: 60,
    startLabel: "Start",
    endLabel: "End",
    durationLabel: "Clip duration",
    formatTime: (seconds) => `0:${String(seconds).padStart(2, "0")}`,
  },
} satisfies Meta<typeof ClipTrimmer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
