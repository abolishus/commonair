// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@commonair/ui/lib/utils";
import { formatNumber } from "../../lib/format.ts";
import { useResolvedLocale } from "../../lib/locale.tsx";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { DataTable, type DataTableColumn } from "../data/data-table.tsx";

/** One scope of a decided tally: member-wide or one class (`TallyBreakdown`). */
export interface TallyTableRow {
  /** `member_wide`, `streamer`, `viewer` or `worker`; set as `data-scope`. */
  scope: string;
  label: React.ReactNode;
  yes: number;
  no: number;
  abstain: number;
  eligible: number;
}

/** One rule check of the tally (`TallyBreakdown.checks`). */
export interface TallyTableCheck {
  /** `TALLY_RULES` id; set as `data-rule`. */
  rule: string;
  label: React.ReactNode;
  /** The threshold text ("turnout 4/4 (100.00%), at least 1.00% required"). */
  detail?: React.ReactNode;
  passed: boolean;
}

export interface TallyTableLabels {
  /** Table caption (screen readers). */
  caption: string;
  scope: string;
  yes: string;
  no: string;
  abstain: string;
  eligible: string;
  turnout: string;
  /** Heading above the checks. */
  checks: string;
  checkPassed: string;
  checkFailed: string;
}

export interface TallyTableProps extends Omit<React.ComponentProps<"section">, "children"> {
  passed: boolean;
  /** "Passed" / "Rejected". */
  outcomeLabel: string;
  /** Why (the tally's reason string, translated). */
  reason?: React.ReactNode;
  rows: TallyTableRow[];
  checks: TallyTableCheck[];
  labels: TallyTableLabels;
  /** Set on every row besides its counts (e.g. `{ "data-testid": "tally-row" }`). */
  rowProps?: DataAttributes;
  /** Set on every check besides `data-rule` / `data-passed`. */
  checkProps?: DataAttributes;
  locale?: string;
}

/**
 * The decided tally of a proposal: counts per scope with turnout, then every rule check with its
 * threshold. Only for decided proposals; an open vote shows `VoteParticipation` instead.
 */
export function TallyTable({
  passed,
  outcomeLabel,
  reason,
  rows,
  checks,
  labels,
  rowProps,
  checkProps,
  locale,
  className,
  ...props
}: TallyTableProps): React.JSX.Element {
  const resolved = useResolvedLocale(locale);
  const count = (value: number): string => formatNumber(value, resolved);
  const turnout = (row: TallyTableRow): string => {
    if (row.eligible <= 0) return "–";
    const share = (row.yes + row.no + row.abstain) / row.eligible;
    return new Intl.NumberFormat(resolved, { style: "percent", maximumFractionDigits: 1 }).format(share);
  };
  const columns: DataTableColumn<TallyTableRow>[] = [
    { id: "scope", header: labels.scope, cell: ({ row }) => <span className="font-medium">{row.original.label}</span> },
    { id: "yes", header: labels.yes, align: "numeric", cell: ({ row }) => count(row.original.yes) },
    { id: "no", header: labels.no, align: "numeric", cell: ({ row }) => count(row.original.no) },
    { id: "abstain", header: labels.abstain, align: "numeric", cell: ({ row }) => count(row.original.abstain) },
    { id: "eligible", header: labels.eligible, align: "numeric", cell: ({ row }) => count(row.original.eligible) },
    { id: "turnout", header: labels.turnout, align: "numeric", cell: ({ row }) => turnout(row.original) },
  ];
  return (
    <section data-passed={String(passed)} className={cn("flex min-w-0 flex-col gap-4", className)} {...props}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={passed ? "success" : "danger"} icon={passed ? Tick02Icon : Cancel01Icon}>
          {outcomeLabel}
        </StatusBadge>
        {reason ? <p className="text-xs text-muted-foreground">{reason}</p> : null}
      </div>
      <DataTable
        caption={labels.caption}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.scope}
        rowProps={(row) => ({
          ...rowProps,
          "data-scope": row.scope,
          "data-yes": row.yes,
          "data-no": row.no,
          "data-abstain": row.abstain,
          "data-eligible": row.eligible,
        })}
      />
      {checks.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">{labels.checks}</h3>
          <ul className="flex flex-col gap-2">
            {checks.map((check) => (
              <li
                {...checkProps}
                key={check.rule}
                data-rule={check.rule}
                data-passed={String(check.passed)}
                className="flex min-w-0 items-start gap-2 text-xs"
              >
                <HugeiconsIcon
                  icon={check.passed ? Tick02Icon : Cancel01Icon}
                  strokeWidth={2}
                  aria-hidden
                  className={cn("mt-0.5 size-3.5 shrink-0", check.passed ? "text-success" : "text-destructive")}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium">{check.label}</span>
                  {check.detail ? <span className="text-muted-foreground wrap-anywhere">{check.detail}</span> : null}
                </div>
                <span className={cn("shrink-0", check.passed ? "text-success" : "text-destructive")}>
                  {check.passed ? labels.checkPassed : labels.checkFailed}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
