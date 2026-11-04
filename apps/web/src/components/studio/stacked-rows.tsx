// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F31: a table whose key columns are money or actions renders as stacked rows below `sm`, one
 * card-like row per record with its amount and actions on the row, instead of a table that clips
 * those columns off screen with no cue. From `sm` the table shows; the two never show together.
 * While loading or empty only the table renders (its skeleton and empty state serve both widths).
 */
import * as React from "react";

export interface StackedRow {
  id: string;
  /** The row's name (a date and type, a command). */
  title: React.ReactNode;
  /** Smaller lines under the title. */
  details?: React.ReactNode;
  /** The value that must stay visible: an amount, a count. End-aligned beside the title. */
  value?: React.ReactNode;
  actions?: React.ReactNode;
  /** `data-*` attributes for the row (test ids, raw values). */
  attributes?: Record<`data-${string}`, string | number | undefined>;
}

export interface ResponsiveRowsProps {
  /** The table (a `DataTable`), shown from `sm`. */
  table: React.ReactElement<{ className?: string }>;
  rows: readonly StackedRow[] | null;
  /** The list's accessible name (the table's caption). */
  label: string;
  /** Under the list on phones (a "load more" button), like the table's footer. */
  footer?: React.ReactNode;
}

export function ResponsiveRows({ table, rows, label, footer }: ResponsiveRowsProps): React.JSX.Element {
  if (rows === null || rows.length === 0) return table;
  return (
    <>
      {React.cloneElement(table, { className: "hidden sm:block" })}
      <div data-slot="stacked-rows" className="flex flex-col gap-3 sm:hidden">
        <ul aria-label={label} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rows.map((row) => (
            <li key={row.id} {...row.attributes} className="flex min-w-0 flex-col gap-2 p-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 text-sm font-medium break-words">{row.title}</div>
                {row.value !== undefined && <div className="shrink-0 text-sm tabular-nums">{row.value}</div>}
              </div>
              {row.details !== undefined && (
                <div className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">{row.details}</div>
              )}
              {row.actions !== undefined && <div className="flex flex-wrap items-center gap-2">{row.actions}</div>}
            </li>
          ))}
        </ul>
        {footer}
      </div>
    </>
  );
}
