// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { FieldError } from "../../src/components/field.tsx";
import { OptionGroup } from "../../src/blocks/forms/index.ts";

const meta = { title: "Blocks/Forms/OptionCard" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const Example = () => (
  <OptionGroup
    aria-label="Membership tier"
    defaultValue="supporter"
    items={[
      {
        value: "supporter",
        title: "Supporter",
        description: "Help fund the cooperative.",
        price: { cents: 500, currency: "USD" },
      },
      {
        value: "partner",
        title: "Partner",
        description: "Extra member benefits.",
        price: { cents: 1200, currency: "USD" },
      },
    ]}
  />
);
export const Default: Story = { render: () => <Example /> };
export const Light: Story = { render: () => <Example />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Example />, globals: { viewport: { value: "mobile320" } } };
export const Disabled: Story = {
  render: () => (
    <fieldset disabled className="rounded-none border p-3">
      <legend>Disabled</legend>
      <Example />
    </fieldset>
  ),
};
export const ErrorState: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <Example />
      <FieldError>Example validation error</FieldError>
    </div>
  ),
};
