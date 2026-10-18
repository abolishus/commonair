// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { MoneyAmount, RelativeTime } from "../src/index.ts";

const meta = {
  title: "Primitives/RelativeTime and MoneyAmount",
  component: RelativeTime,
  args: { date: new Date(Date.now() - 5 * 60_000).toISOString() },
} satisfies Meta<typeof RelativeTime>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FiveMinutesAgo: Story = {};

const OFFSETS = [
  -3_000,
  -45_000,
  -5 * 60_000,
  -3 * 3_600_000,
  -86_400_000,
  -9 * 86_400_000,
  -400 * 86_400_000,
  2 * 3_600_000,
];

/** Live-updating: watch the first rows tick. Hover a value for the absolute time. */
export const Range: Story = {
  render: () => {
    const now = Date.now();
    return (
      <ul className="flex flex-col gap-1 text-sm">
        {OFFSETS.map((offset) => (
          <li key={offset}>
            <RelativeTime date={now + offset} />
          </li>
        ))}
      </ul>
    );
  },
};

export const RangeFrench: Story = { ...Range, globals: { locale: "fr" } };
export const RangeArabicRtl: Story = { ...Range, globals: { locale: "ar", dir: "rtl" } };
export const InvalidDate: Story = { args: { date: "not a date" } };

const AMOUNTS: { cents: number; currency: string }[] = [
  { cents: 499, currency: "USD" },
  { cents: 123_456, currency: "EUR" },
  { cents: 1_234, currency: "JPY" },
  { cents: 1_500, currency: "KWD" },
  { cents: -2_500, currency: "USD" },
  { cents: 0, currency: "GBP" },
  { cents: 900_719_925_474_099, currency: "USD" },
];

export const Money: Story = {
  render: () => (
    <table className="text-sm">
      <tbody>
        {AMOUNTS.map((value, i) => (
          <tr key={i}>
            <td className="pe-6 text-muted-foreground">{value.currency}</td>
            <td className="pe-6 text-end">
              <MoneyAmount value={value} />
            </td>
            <td className="text-end">
              <MoneyAmount value={value} signDisplay="exceptZero" colorNegative />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ),
};

export const MoneyGerman: Story = { ...Money, globals: { locale: "de" } };
export const MoneyLight: Story = { ...Money, globals: { theme: "light" } };
export const MoneyMobile320: Story = { ...Money, globals: { viewport: { value: "mobile320" } } };
