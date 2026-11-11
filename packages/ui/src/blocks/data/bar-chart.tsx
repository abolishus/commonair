// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- An SVG chart takes the img role; there is no tag for it. */

/**
 * Daily bars (overhaul D5.6, creator-studio CS-8): sparse per-day figures (hours, peaks, money)
 * read as bars, not lines. Plain SVG, so it renders the same on the server and the client with no
 * layout measuring. Bars stretch with the width (`preserveAspectRatio="none"`); every label is
 * HTML beside the SVG, so text never scales. Ticks are whole numbers unless `maxDecimals` allows
 * more. Optional ghost bars show the previous period behind each bar. The figures are always in
 * a table too: hidden behind a toggle when `table` is given, screen-reader only otherwise.
 */
import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@commonair/ui/components/collapsible";
import { cn } from "@commonair/ui/lib/utils";
import { formatNumber } from "../../lib/format.ts";
import { useResolvedLocale } from "../../lib/locale.tsx";
import type { ChartColor } from "./breakdown.tsx";
import { DataTable, type DataTableColumn } from "./data-table.tsx";

export interface BarDatum {
  /** Stable id (a date): the table row id and the bar's `data-key`. */
  key: string;
  /** The axis and table label ("Nov 3"). */
  label: string;
  value: number;
  /** The same slot one period earlier (a ghost bar behind this one). */
  previous?: number;
}

export interface BarChartTable {
  caption: string;
  /** The first column's header ("Day"). */
  categoryHeader: string;
  /** The toggle's text ("Show as a table"). */
  showLabel: string;
}

export interface BarChartProps extends Omit<React.ComponentProps<"figure">, "children"> {
  data: BarDatum[];
  ariaLabel: string;
  /** The series' name (legend and table header). */
  seriesLabel: string;
  /** Set to draw ghost bars for `previous` (and name them in the legend and table). */
  previousLabel?: string;
  color?: ChartColor;
  /** Ticks, table cells: money in cents, hours. Default: the number for the locale. */
  formatValue?: (value: number) => string;
  /** Decimals a tick may have: 0 (default) for counts, 1 for hours. */
  maxDecimals?: number;
  /** The smallest tick step (e.g. 100 for whole currency units in cents). */
  minStep?: number;
  /** At most this many day labels under the bars (evenly thinned). Default 7. */
  maxLabels?: number;
  /** A visible table behind a toggle; without it the table is for screen readers only. */
  table?: BarChartTable;
  locale?: string;
}

/** View box units per bar slot and for the plot height. */
const SLOT = 10;
const HEIGHT = 100;

const roundTo = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/**
 * Evenly spaced ticks from a nice minimum (≤ 0) to a nice maximum (≥ 0) on a 1-2-5 step, at most
 * `maxDecimals` decimals and never a step under `minStep`. All zeros give `[0, step]`.
 */
export function barTicks(
  values: readonly number[],
  { maxDecimals = 0, minStep, count = 4 }: { maxDecimals?: number; minStep?: number; count?: number } = {},
): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  const lo = Math.min(0, ...finite);
  const hi = Math.max(0, ...finite);
  const floor = Math.max(minStep ?? 0, 10 ** -Math.max(0, maxDecimals));
  const raw = (hi - lo) / Math.max(1, count);
  let step = floor;
  if (raw > floor) {
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    step = Math.max(floor, step);
  }
  const decimals = Math.max(0, maxDecimals);
  const min = roundTo(Math.floor(lo / step + 1e-9) * step, decimals);
  let max = roundTo(Math.ceil(hi / step - 1e-9) * step, decimals);
  if (max === min) max = roundTo(min + step, decimals);
  const ticks: number[] = [];
  for (let i = 0; ; i++) {
    const tick = roundTo(min + i * step, decimals);
    if (tick > max + step / 2) break;
    ticks.push(tick);
  }
  return ticks;
}

/** Which of `n` labels to show so at most `max` appear, the first and last always among them. */
export function labelIndexes(n: number, max: number): Set<number> {
  if (n <= 0) return new Set();
  if (n <= max || max < 2) return new Set(Array.from({ length: n }, (_, i) => i));
  const every = Math.ceil((n - 1) / (max - 1));
  const shown = new Set<number>();
  for (let i = 0; i < n; i += every) shown.add(i);
  // The last day replaces a label that would crowd it.
  const last = n - 1;
  for (const i of shown) if (i !== 0 && last - i < every / 2) shown.delete(i);
  shown.add(last);
  return shown;
}

export function BarChart({
  data,
  ariaLabel,
  seriesLabel,
  previousLabel,
  color = "--chart-1",
  formatValue: formatValueProp,
  maxDecimals = 0,
  minStep,
  maxLabels = 7,
  table,
  locale,
  className,
  ...props
}: BarChartProps) {
  const resolved = useResolvedLocale(locale);
  const formatValue = formatValueProp ?? ((value: number) => formatNumber(value, resolved));
  const ghosts = previousLabel !== undefined && data.some((d) => d.previous !== undefined);
  const ticks = barTicks(
    data.flatMap((d) => (ghosts && d.previous !== undefined ? [d.value, d.previous] : [d.value])),
    { maxDecimals, ...(minStep !== undefined ? { minStep } : {}) },
  );
  const lo = ticks[0] ?? 0;
  const hi = ticks.at(-1) ?? 1;
  const y = (v: number) => (HEIGHT * (hi - v)) / (hi - lo || 1);
  const width = Math.max(1, data.length) * SLOT;
  const shown = labelIndexes(data.length, maxLabels);
  const fill = `var(${color})`;

  type Row = BarDatum;
  const columns: DataTableColumn<Row>[] = [
    { id: "label", header: table?.categoryHeader ?? "", cell: ({ row }) => row.original.label },
    { id: "value", header: seriesLabel, align: "numeric", cell: ({ row }) => formatValue(row.original.value) },
    ...(ghosts && previousLabel
      ? [
          {
            id: "previous",
            header: previousLabel,
            align: "numeric",
            cell: ({ row }) => (row.original.previous === undefined ? "" : formatValue(row.original.previous)),
          } satisfies DataTableColumn<Row>,
        ]
      : []),
  ];
  const figures = (
    <DataTable caption={table?.caption ?? ariaLabel} columns={columns} rows={data} getRowId={(d) => d.key} />
  );

  return (
    <figure
      data-slot="bar-chart"
      data-bars={data.length}
      className={cn("m-0 flex min-w-0 flex-col gap-3", className)}
      {...props}
    >
      <div className="flex min-w-0 gap-2">
        <div
          aria-hidden="true"
          className="flex h-48 shrink-0 flex-col-reverse justify-between text-end text-xs leading-none text-muted-foreground tabular-nums"
        >
          {ticks.map((tick) => (
            <span key={tick}>{formatValue(tick)}</span>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <svg
            role="img"
            aria-label={ariaLabel}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="h-48 w-full overflow-visible"
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={width}
                y1={y(tick)}
                y2={y(tick)}
                vectorEffect="non-scaling-stroke"
                className={tick === 0 ? "stroke-muted-foreground" : "stroke-border"}
                strokeWidth={1}
              />
            ))}
            {data.map((d, i) => {
              const ghost = ghosts && d.previous !== undefined && d.previous !== 0 ? d.previous : null;
              return (
                <g key={d.key} data-key={d.key} data-value={d.value}>
                  {ghost !== null ? (
                    <rect
                      data-ghost=""
                      x={i * SLOT + 0.5}
                      width={SLOT - 1}
                      y={Math.min(y(ghost), y(0))}
                      height={Math.abs(y(ghost) - y(0))}
                      fill={fill}
                      fillOpacity={0.25}
                    />
                  ) : null}
                  {d.value !== 0 ? (
                    <rect
                      x={i * SLOT + 2}
                      width={SLOT - 4}
                      y={Math.min(y(d.value), y(0))}
                      height={Math.abs(y(d.value) - y(0))}
                      fill={fill}
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
          {/* Each label sits in its bar's slot and may spill into the empty slots beside it; the
              first and last lean inwards so nothing pokes out of the chart at 320 px. */}
          <div aria-hidden="true" className="flex min-w-0 overflow-hidden text-xs text-muted-foreground">
            {data.map((d, i) => (
              <span
                key={d.key}
                className={cn(
                  "flex min-w-0 flex-1 basis-0 whitespace-nowrap",
                  i === 0 && data.length > 1
                    ? "justify-start"
                    : i === data.length - 1
                      ? "justify-end"
                      : "justify-center",
                )}
              >
                {shown.has(i) ? d.label : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
      {ghosts ? (
        <ul aria-hidden="true" className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <li className="flex items-center gap-2">
            <Swatch fill={fill} />
            {seriesLabel}
          </li>
          <li className="flex items-center gap-2">
            <Swatch fill={fill} ghost />
            {previousLabel}
          </li>
        </ul>
      ) : null}
      {table ? (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>{table.showLabel}</CollapsibleTrigger>
          <CollapsibleContent className="pt-3">{figures}</CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="sr-only">{figures}</div>
      )}
    </figure>
  );
}

function Swatch({ fill, ghost = false }: { fill: string; ghost?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 10 10" className="size-3 shrink-0">
      <rect width={10} height={10} fill={fill} fillOpacity={ghost ? 0.25 : 1} />
    </svg>
  );
}
