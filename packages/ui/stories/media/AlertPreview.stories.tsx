// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertPreview } from "../../src/blocks/media/alert-preview.tsx";
const meta = {
  title: "Blocks/Media/AlertPreview",
  component: AlertPreview,
  args: {
    name: "Fernsby",
    eventLabel: "Fernsby tipped",
    amount: { cents: 500, currency: "USD" },
    message: "Thanks for keeping the lights on!",
    stageLabel: "Tip alert preview",
  },
} satisfies Meta<typeof AlertPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
