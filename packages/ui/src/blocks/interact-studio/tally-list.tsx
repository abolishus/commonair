// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { cn } from "../../lib/utils.ts";
import { ProgressRow, type ProgressTone } from "../data/progress-row.tsx";

export interface TallyItem {
  id: string;
  label: string;
  /** Votes or points: the bar shows this item's share of the list's total. */
  value: number;
  /** The formatted value ("3 votes", "1,200 points · 4 viewers"). */
  valueText: React.ReactNode;
  /** A line under the bar (a payout, "refunded"). */
  note?: React.ReactNode;
  tone?: ProgressTone;
  /** Shown beside the label (a "Winner" badge). */
  badge?: React.ReactNode;
  /** A control for this item (resolve to this outcome). */
  action?: React.ReactNode;
  /** `data-*` for the item's row (e2e test id and the raw numbers). */
  rowProps?: DataAttributes;
}

export interface TallyListProps extends Omit<React.ComponentProps<"ul">, "children"> {
  items: readonly TallyItem[];
  /** Accessible name of the list ("Poll results"). */
  label: string;
}

/** Share of `total` in whole percent; 0 when nothing was counted. */
export function tallyPercent(value: number, total: number): number {
  if (total <= 0 || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

/**
 * Live counts of a poll or a prediction: one row per choice or outcome with its share as a bar,
 * an optional badge, note and control. Every string comes in as a prop.
 */
export function TallyList({ items, label, className, ...props }: TallyListProps): React.JSX.Element {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  return (
    <ul aria-label={label} className={cn("grid gap-4", className)} {...props}>
      {items.map((item) => (
        <li key={item.id} className="grid gap-2" {...item.rowProps}>
          {item.badge ? <div className="flex flex-wrap items-center gap-2">{item.badge}</div> : null}
          <ProgressRow
            label={item.label}
            value={tallyPercent(item.value, total)}
            valueText={item.valueText}
            note={item.note}
            tone={item.tone}
          />
          {item.action ? <div className="flex flex-wrap gap-2">{item.action}</div> : null}
        </li>
      ))}
    </ul>
  );
}
