// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataTable } from "../../src/blocks/data/index.ts";

const meta = { title: "Blocks/Data/DataTable", component: DataTable, parameters: { layout: "padded" } } satisfies Meta<
  typeof DataTable
>;
export default meta;
type Story = StoryObj;
export const Default: Story = {
  render: () => (
    <DataTable
      caption="Recent ledger entries"
      sortable
      columns={[
        { id: "date", accessorKey: "date", header: "Date", enableSorting: true },
        { id: "description", accessorKey: "description", header: "Description" },
        { id: "amount", accessorKey: "amount", header: "Amount", align: "numeric" },
      ]}
      rows={[
        { date: "2026-10-18", description: "Member subscriptions", amount: "$8,240.00" },
        { date: "2026-10-17", description: "Stream hosting", amount: "−$420.00" },
        { date: "2026-10-16", description: "Co-op pledges", amount: "$1,280.00" },
      ]}
    />
  ),
};
export const Light: Story = { ...Default, globals: { theme: "light" } };
export const Mobile320: Story = { ...Default, globals: { viewport: { value: "mobile320" } } };
