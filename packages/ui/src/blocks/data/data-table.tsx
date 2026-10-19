// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Button } from "@commonair/ui/components/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter,
} from "@commonair/ui/components/table";
import { Skeleton } from "../../primitives/skeletons.tsx";
import { EmptyState } from "../../primitives/empty-state.tsx";
import { cn } from "@commonair/ui/lib/utils";

export type DataTableColumn<T> = ColumnDef<T, unknown> & { id: string; align?: "default" | "numeric" };
/** Selected row ids (from `getRowId`, else the row index) mapped to `true`. */
export type DataTableRowSelection = RowSelectionState;
export interface DataTableProps<T> extends Omit<React.ComponentProps<"div">, "children"> {
  columns: DataTableColumn<T>[];
  rows: T[];
  caption: string;
  sortable?: boolean;
  selectable?: boolean;
  selectionLabel?: string;
  selectionToolbar?: (selected: T[], clear: () => void) => React.ReactNode;
  /** Controlled selection; pair with `onRowSelectionChange`. */
  rowSelection?: DataTableRowSelection;
  /** Initial selection when uncontrolled. */
  defaultRowSelection?: DataTableRowSelection;
  onRowSelectionChange?: (selection: DataTableRowSelection) => void;
  rowProps?: (
    row: T,
  ) => React.HTMLAttributes<HTMLTableRowElement> & Record<`data-${string}`, string | number | undefined>;
  empty?: React.ReactNode;
  loading?: boolean;
  loadingRows?: number;
  getRowId?: (row: T, index: number) => string;
  groupBy?: (row: T) => string | undefined;
  footer?: React.ReactNode;
}
export function DataTable<T>({
  columns,
  rows,
  caption,
  sortable = false,
  selectable = false,
  selectionLabel = caption,
  selectionToolbar,
  rowSelection,
  defaultRowSelection,
  onRowSelectionChange,
  rowProps,
  empty,
  loading = false,
  loadingRows = 5,
  getRowId,
  groupBy,
  footer,
  className,
  ...props
}: DataTableProps<T>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [innerSelection, setInnerSelection] = React.useState<RowSelectionState>(defaultRowSelection ?? {});
  const selection = rowSelection ?? innerSelection;
  const setSelection = (updater: RowSelectionState | ((old: RowSelectionState) => RowSelectionState)): void => {
    const next = typeof updater === "function" ? updater(selection) : updater;
    if (rowSelection === undefined) setInnerSelection(next);
    onRowSelectionChange?.(next);
  };
  const selectionColumn: DataTableColumn<T> = {
    id: "select",
    header: "",
    enableSorting: false,
    cell: ({ row }) => (
      <Checkbox
        aria-label={`${selectionLabel} ${row.index + 1}`}
        checked={row.getIsSelected()}
        onCheckedChange={(checked) => row.toggleSelected(checked === true)}
      />
    ),
  };
  // TanStack owns sorting/selection state; its returned model is intentionally rendered here.
  // oxlint-disable-next-line react/incompatible-library
  const table = useReactTable({
    data: rows,
    columns: [...(selectable ? [selectionColumn] : []), ...columns],
    state: { sorting, rowSelection: selection },
    onSortingChange: setSorting,
    onRowSelectionChange: setSelection,
    enableRowSelection: selectable,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    ...(sortable
      ? {
          getSortedRowModel: getSortedRowModel(),
          getFilteredRowModel: getFilteredRowModel(),
        }
      : {}),
  });
  const selected = table.getSelectedRowModel().rows.map((r) => r.original);
  let previousGroup: string | undefined;
  return (
    <div className={cn("grid gap-2", className)} {...props}>
      {selected.length && selectionToolbar ? selectionToolbar(selected, () => setSelection({})) : null}
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  scope="col"
                  className={
                    (header.column.columnDef as DataTableColumn<T>).align === "numeric"
                      ? "text-right tabular-nums"
                      : undefined
                  }
                >
                  {header.isPlaceholder ? null : sortable && header.column.getCanSort() ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 font-medium"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === "asc"
                        ? " ↑"
                        : header.column.getIsSorted() === "desc"
                          ? " ↓"
                          : ""}
                    </Button>
                  ) : (
                    flexRender(header.column.columnDef.header, header.getContext())
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: loadingRows }, (_, i) => (
              <TableRow key={`loading-${i}`}>
                <TableCell colSpan={columns.length + Number(selectable)}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              </TableRow>
            ))
          ) : table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => {
              const group = groupBy?.(row.original);
              const showGroup = group !== undefined && group !== previousGroup;
              previousGroup = group;
              return (
                <React.Fragment key={row.id}>
                  {showGroup ? (
                    <TableRow data-group-row="true">
                      <TableCell colSpan={row.getVisibleCells().length} className="font-medium">
                        {group}
                      </TableCell>
                    </TableRow>
                  ) : null}
                  <TableRow
                    data-state={row.getIsSelected() ? "selected" : undefined}
                    {...(rowProps?.(row.original) ?? {})}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={
                          (cell.column.columnDef as DataTableColumn<T>).align === "numeric"
                            ? "text-right tabular-nums"
                            : undefined
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                </React.Fragment>
              );
            })
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length + Number(selectable)}>
                {empty ?? <EmptyState title={caption} description={undefined} />}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
        {footer ? (
          <TableFooter>
            <TableRow>
              <TableCell colSpan={columns.length + Number(selectable)}>{footer}</TableCell>
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
    </div>
  );
}
