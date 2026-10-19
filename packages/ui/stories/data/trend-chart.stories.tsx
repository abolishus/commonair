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
