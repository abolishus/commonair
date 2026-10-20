// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FieldError } from "../../src/components/field.tsx";
import { AmountField } from "../../src/blocks/forms/index.ts";

const meta = { title: "Blocks/Forms/AmountField" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const Example = () => (
  <AmountField
    label="Tip amount"
    currency="USD"
    value={500}
    onValueChange={() => undefined}
    presets={[
      { label: "$5", value: 500 },
      { label: "$10", value: 1000 },
      { label: "$25", value: 2500 },
    ]}
    min={100}
    max={100000}
    rangeError="Choose an amount within the allowed range."
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
/** `inputProps` reach the `<input>`, which also carries `data-cents` (the parsed value). */
export const WithInputTestId: Story = {
  render: function Render() {
    const [cents, setCents] = React.useState(500);
    return (
      <AmountField
        label="Tip amount"
        currency="USD"
        value={cents}
        onValueChange={setCents}
        min={100}
        rangeError="Tips start at $1.00."
        inputProps={{ "data-testid": "support-tip-amount" }}
      />
    );
  },
};
/** Unparsed text (try clearing the field): `data-cents` empties and the format error shows. */
export const UnparsedText: StoryObj<{ formatError?: string }> = {
  args: { formatError: "Enter an amount, like 5.00." },
  render: function Render(args: { formatError?: string }) {
    const [cents, setCents] = React.useState(500);
    const [valid, setValid] = React.useState(true);
    return (
      <div className="flex flex-col gap-2">
        <AmountField
          label="Tip amount"
          currency="USD"
          value={cents}
          onValueChange={setCents}
          onValidityChange={setValid}
          min={100}
          rangeError="Tips start at $1.00."
          formatError={args.formatError}
          inputProps={{ "data-testid": "support-tip-amount" }}
        />
        <p className="text-muted-foreground">{valid ? "Valid" : "Invalid"}</p>
      </div>
    );
  },
};
export const ErrorState: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <Example />
      <FieldError>Example validation error</FieldError>
    </div>
  ),
};
