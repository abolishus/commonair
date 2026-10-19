// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "@commonair/ui/lib/utils";

export interface KeyValueRow {
  term: React.ReactNode;
  value: React.ReactNode;
}
export interface KeyValueListProps extends React.ComponentProps<"dl"> {
  rows: KeyValueRow[];
  dense?: boolean;
}
/** Term/value pairs. Each pair is a `div` row (valid inside `dl`): the term shrinks, the value never wraps away. */
export function KeyValueList({ rows, dense = false, className, ...props }: KeyValueListProps) {
  return (
    <dl className={cn("flex flex-col", dense ? "gap-1" : "gap-2", className)} {...props}>
      {rows.map((row, index) => (
        <div key={index} className="flex min-w-0 items-baseline justify-between gap-3">
          <dt className="min-w-0 text-xs text-muted-foreground">{row.term}</dt>
          <dd className="shrink-0 text-right text-xs tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
