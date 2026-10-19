// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { AccentButton } from "../../src/primitives/accent-button.tsx";
import type { Accent } from "../../src/primitives/channel-avatar.tsx";

const meta = { title: "Primitives/AccentButton", component: AccentButton } satisfies Meta<typeof AccentButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Accents: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(["teal", "violet", "pink", "amber", "blue", "green"] as Accent[]).map((accent) => (
        <AccentButton key={accent} accent={accent} size="sm">
          Follow · {accent}
        </AccentButton>
      ))}
    </div>
  ),
};
export const Light: Story = { ...Accents, globals: { theme: "light" } };
export const Mobile320: Story = { ...Accents, globals: { viewport: { value: "mobile320" } } };
