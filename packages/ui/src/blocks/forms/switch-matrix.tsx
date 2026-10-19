// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { FieldLegend, FieldSet } from "@commonair/ui/components/field";
import { Switch } from "@commonair/ui/components/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@commonair/ui/components/table";

export interface SwitchMatrixRow {
  id: string;
  label: string;
  values: Readonly<Record<string, boolean>>;
}
export interface SwitchMatrixProps {
  label: string;
  columns: readonly { id: string; label: string }[];
  rows: readonly SwitchMatrixRow[];
  onValueChange: (rowId: string, columnId: string, checked: boolean) => void;
  "data-testid"?: string;
}
export function SwitchMatrix({ label, columns, rows, onValueChange, ...props }: SwitchMatrixProps): React.JSX.Element {
  return (
    <FieldSet aria-label={label} data-testid={props["data-testid"]}>
      <FieldLegend className="sr-only">{label}</FieldLegend>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{label}</TableHead>
            {columns.map((column) => (
              <TableHead key={column.id} className="max-sm:hidden">
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className="max-sm:flex max-sm:flex-col max-sm:items-stretch">
              <TableHead scope="row" className="whitespace-normal">
                {row.label}
              </TableHead>
              {columns.map((column) => {
                const name = `${row.label} ${column.label}`;
                return (
                  <TableCell
                    key={column.id}
                    className="flex items-center justify-between gap-2 text-left sm:table-cell sm:text-center"
                  >
                    <span className="sm:hidden">{column.label}</span>
                    <Switch
                      aria-label={name}
                      checked={row.values[column.id] ?? false}
                      onCheckedChange={(checked) => onValueChange(row.id, column.id, checked)}
                    />
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </FieldSet>
  );
}
