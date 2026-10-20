// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { FieldError } from "../../src/components/field.tsx";
import { ChoiceToggle } from "../../src/blocks/forms/index.ts";

const meta = { title: "Blocks/Forms/ChoiceToggle" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const Example = () => (
  <ChoiceToggle
    label="Protocol"
    defaultValue="hls"
    options={[
      { value: "hls", label: "HLS" },
      { value: "rtmp", label: "RTMP" },
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
/** Many presets wrap onto more rows at 320 px; an option can be disabled on its own. */
export const WrapAndDisabledOption: Story = {
  render: () => (
    <ChoiceToggle
      label="How many subs?"
      defaultValue="5"
      wrap
      options={["1", "5", "10", "20", "50", "100"].map((value) => ({ value, label: value, disabled: value === "100" }))}
    />
  ),
};
export const WrapMobile320: Story = { ...WrapAndDisabledOption, globals: { viewport: { value: "mobile320" } } };
