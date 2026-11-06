// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Table, TableBody, TableCaption, TableCell, TableRow } from "../src/components/table.tsx";
import { MoneyAmount, RelativeTime, formatHour } from "../src/index.ts";

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

const ELAPSED = [5_000, 4 * 60_000 + 5_000, 3_723_000, 49 * 3_600_000];

/** `mode="elapsed"`: an uptime clock that ticks every second. Hover a value for the start time. */
export const Elapsed: Story = {
  render: () => {
    const now = Date.now();
    return (
      <ul className="flex flex-col gap-1 text-sm">
        {ELAPSED.map((ago) => (
          <li key={ago}>
            <RelativeTime mode="elapsed" date={now - ago} />
          </li>
        ))}
      </ul>
    );
  },
};

export const ElapsedStatic: Story = { args: { mode: "elapsed", live: false } };

const HOUR_LOCALES = ["en-US", "en-GB", "es", "de", "ja", "ko"];

/** `formatHour`: each locale's own clock for an hour picker (12-hour with the day period, or 24-hour). */
export const Hours: Story = {
  render: () => (
    <Table className="w-auto">
      <TableCaption className="sr-only">Hour formatting samples</TableCaption>
      <TableBody>
        {HOUR_LOCALES.map((locale) => (
          <TableRow key={locale}>
            <TableCell className="text-muted-foreground">{locale}</TableCell>
            {[0, 9, 12, 15, 23].map((hour) => (
              <TableCell key={hour} className="text-end tabular-nums">
                {formatHour(hour, locale)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

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
    <Table className="w-auto">
      <TableCaption className="sr-only">Money formatting samples</TableCaption>
      <TableBody>
        {AMOUNTS.map((value, i) => (
          <TableRow key={i}>
            <TableCell className="text-muted-foreground">{value.currency}</TableCell>
            <TableCell className="text-end">
              <MoneyAmount value={value} />
            </TableCell>
            <TableCell className="text-end">
              <MoneyAmount value={value} signDisplay="exceptZero" colorNegative />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

export const MoneyGerman: Story = { ...Money, globals: { locale: "de" } };
export const MoneyLight: Story = { ...Money, globals: { theme: "light" } };
export const MoneyMobile320: Story = { ...Money, globals: { viewport: { value: "mobile320" } } };
