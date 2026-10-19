// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SelectField } from "../../src/blocks/forms/index.ts";

const meta = { title: "Blocks/Forms/SelectField", component: SelectField } satisfies Meta<typeof SelectField>;
export default meta;
type Story = StoryObj;

const latencies = [
  { value: "normal", label: "Normal (8–12 s)" },
  { value: "low", label: "Low latency (3–5 s)" },
  { value: "ultra", label: "Ultra-low (coming later)", disabled: true },
];

function Controlled(): React.JSX.Element {
  const [value, setValue] = React.useState("low");
  return (
    <SelectField
      label="Latency"
      options={latencies}
      value={value}
      onValueChange={setValue}
      description="Lower latency means more buffering for viewers on slow connections."
    />
  );
}

export const Default: Story = { render: () => <Controlled /> };
export const Light: Story = { render: () => <Controlled />, globals: { theme: "light" } };
export const Mobile320: Story = { render: () => <Controlled />, globals: { viewport: { value: "mobile320" } } };
export const Uncontrolled: Story = {
  render: () => <SelectField label="Duration" options={latencies} defaultValue="normal" />,
};
export const Placeholder: Story = {
  render: () => <SelectField label="Message to user" options={latencies} placeholder="Choose a template" />,
};
export const ErrorState: Story = {
  render: () => <SelectField label="Latency" options={latencies} placeholder="Choose" error="Pick a latency." />,
};
export const Disabled: Story = {
  render: () => <SelectField label="Latency" options={latencies} defaultValue="normal" disabled />,
};
export const Horizontal: Story = {
  render: () => <SelectField label="Pay with" options={latencies} defaultValue="normal" orientation="horizontal" />,
};
