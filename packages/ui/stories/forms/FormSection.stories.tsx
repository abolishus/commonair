// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { FieldError } from "../../src/components/field.tsx";
import { FormSection, CharacterCountField } from "../../src/blocks/forms/index.ts";

const meta = { title: "Blocks/Forms/FormSection" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const Example = () => (
  <FormSection
    title="Profile settings"
    description="Update your public profile."
    actions={{ saveLabel: "Save changes", cancelLabel: "Cancel" }}
    onSubmit={(event) => event.preventDefault()}
  >
    <CharacterCountField label="Display name" defaultValue="Pixel Pioneer" maxLength={40} />
  </FormSection>
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
