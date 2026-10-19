// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../../src/components/button.tsx";
import { DataTable, type DataTableRowSelection } from "../../src/blocks/data/index.ts";

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

const videoColumns = [
  { id: "title", accessorKey: "title", header: "Video" },
  { id: "views", accessorKey: "views", header: "Views", align: "numeric" as const },
];
const videos = [
  { id: "v1", title: "Friday house set", views: "1,204" },
  { id: "v2", title: "Tape deck, part 3", views: "842" },
  { id: "v3", title: "Q&A", views: "310" },
];

/** Uncontrolled, with the Content board's "2 selected" preselected through `defaultRowSelection`. */
export const DefaultSelection: Story = {
  render: () => (
    <DataTable
      caption="Videos"
      columns={videoColumns}
      rows={videos}
      getRowId={(row) => row.id}
      selectable
      selectionLabel="Select video"
      defaultRowSelection={{ v1: true, v3: true }}
      selectionToolbar={(selected, clear) => (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span>{selected.length} selected</span>
          <Button variant="outline" size="sm" onClick={clear}>
            Clear
          </Button>
        </div>
      )}
    />
  ),
};

function ControlledSelection(): React.JSX.Element {
  const [selection, setSelection] = React.useState<DataTableRowSelection>({ v2: true });
  return (
    <div className="flex flex-col gap-2">
      <DataTable
        caption="Videos"
        columns={videoColumns}
        rows={videos}
        getRowId={(row) => row.id}
        selectable
        selectionLabel="Select video"
        rowSelection={selection}
        onRowSelectionChange={setSelection}
      />
      <p className="text-xs text-muted-foreground">Selected ids: {Object.keys(selection).join(", ") || "none"}</p>
    </div>
  );
}

/** Controlled through `rowSelection` + `onRowSelectionChange`. */
export const ControlledSelectionStory: Story = { name: "Controlled selection", render: () => <ControlledSelection /> };
export const SelectionLight: Story = { ...DefaultSelection, globals: { theme: "light" } };
export const SelectionMobile320: Story = { ...DefaultSelection, globals: { viewport: { value: "mobile320" } } };
