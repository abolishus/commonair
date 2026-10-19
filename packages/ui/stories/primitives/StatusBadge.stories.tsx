// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusBadge } from "../../src/primitives/status-badge.tsx";

const meta = { title: "Primitives/StatusBadge", component: StatusBadge } satisfies Meta<typeof StatusBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(["neutral", "success", "warning", "info", "danger", "accent"] as const).map((tone) => (
        <StatusBadge key={tone} tone={tone}>
          {tone}
        </StatusBadge>
      ))}
    </div>
  ),
};
export const Light: Story = { ...Tones, globals: { theme: "light" } };
export const Mobile320: Story = { ...Tones, globals: { viewport: { value: "mobile320" } } };
