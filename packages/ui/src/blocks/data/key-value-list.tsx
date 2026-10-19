// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "@commonair/ui/lib/utils";

export interface KeyValueRow {
  term: React.ReactNode;
  value: React.ReactNode;
}
export interface KeyValueListProps extends React.ComponentProps<"dl"> {
  rows: KeyValueRow[];
  dense?: boolean;
}
export function KeyValueList({ rows, dense = false, className, ...props }: KeyValueListProps) {
  return (
    <dl
      className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3", dense ? "gap-y-1" : "gap-y-2", className)}
      {...props}
    >
      {rows.map((row, index) => (
        <React.Fragment key={index}>
          <dt className="min-w-0 text-xs text-muted-foreground">{row.term}</dt>
          <dd className="text-right text-xs tabular-nums">{row.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
