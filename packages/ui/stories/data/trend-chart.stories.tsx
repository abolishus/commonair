// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrendChart } from "../../src/blocks/data/index.ts";

const meta = {
  title: "Blocks/Data/TrendChart",
  component: TrendChart,
  parameters: { layout: "padded" },
} satisfies Meta<typeof TrendChart>;
export default meta;
type Story = StoryObj;
const data = [
  { month: "Jan", income: 12000, expenses: 8500 },
  { month: "Feb", income: 14800, expenses: 9100 },
  { month: "Mar", income: 13600, expenses: 8700 },
];
export const Default: Story = {
  render: () => (
    <TrendChart
      ariaLabel="Income and expenses by month"
      type="bar"
      grouped
      data={data}
      xKey="month"
      series={[
        { key: "income", label: "Income", color: "--chart-1" },
        { key: "expenses", label: "Expenses", color: "--chart-2" },
      ]}
    />
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };

/** `legend="top"`: a key-only Legend of the series (Finances board). */
export const WithLegend: Story = {
  render: () => (
    <TrendChart
      ariaLabel="Income and expenses by month"
      type="bar"
      grouped
      legend="top"
      data={data}
      xKey="month"
      series={[
        { key: "income", label: "Income", color: "--chart-2" },
        { key: "expenses", label: "Expenses", color: "--chart-5" },
      ]}
    />
  ),
};
export const WithLegendLight: Story = { ...WithLegend, globals: { theme: "light" } };
export const WithLegendMobile320: Story = { ...WithLegend, globals: { viewport: { value: "mobile320" } } };

/** F24: line series differ by stroke as well as colour, are named where they end, and count in whole ticks. */
const audience = [
  { minute: "0:00", verified: 3, unverified: 1, excluded: 6 },
  { minute: "0:01", verified: 4, unverified: 0, excluded: 6 },
  { minute: "0:02", verified: 6, unverified: 2, excluded: 5 },
  { minute: "0:03", verified: 5, unverified: 1, excluded: 4 },
];
export const LinePatterns: Story = {
  render: () => (
    <TrendChart
      ariaLabel="Viewers per minute"
      legend="bottom"
      directLabels
      allowDecimals={false}
      data={audience}
      xKey="minute"
      series={[
        { key: "verified", label: "Verified", color: "--chart-1" },
        { key: "unverified", label: "Unverified", color: "--chart-3" },
        { key: "excluded", label: "Excluded", color: "--chart-5" },
      ]}
    />
  ),
};
export const LinePatternsLight: Story = { ...LinePatterns, globals: { theme: "light" } };
export const LinePatterns320: Story = { ...LinePatterns, globals: { viewport: { value: "mobile320" } } };
export const LongLabels: Story = {
  render: () => (
    <TrendChart
      ariaLabel="Revenue by day"
      legend="bottom"
      formatValue={(cents) => `$${Math.round(cents / 100)}`}
      data={[
        { day: "Nov 1", gross: 1200, net: 900 },
        { day: "Nov 2", gross: 0, net: 0 },
        { day: "Nov 3", gross: 2500, net: 2100 },
      ]}
      xKey="day"
      series={[
        { key: "gross", label: "Gross revenue before every deduction", color: "--chart-2", dash: "dashed" },
        { key: "net", label: "Net revenue after the co-op cut and refunds", color: "--chart-1", dash: "solid" },
      ]}
    />
  ),
  globals: { viewport: { value: "mobile320" } },
};
export const EmptyData: Story = {
  render: () => (
    <TrendChart
      ariaLabel="No data"
      legend="bottom"
      data={[]}
      xKey="day"
      series={[{ key: "v", label: "Value", color: "--chart-1" }]}
    />
  ),
};
