// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Data visualizations use the required accessible image role. */

import * as React from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipContent, type ChartConfig } from "@commonair/ui/components/chart";
import { cn } from "@commonair/ui/lib/utils";
import { Legend } from "./breakdown.tsx";

/** A line's stroke pattern, so series differ by more than colour (F24, WCAG 1.4.1). */
export type TrendDash = "solid" | "dashed" | "dotted" | "dashDot";
const DASH_ARRAY: Record<TrendDash, string | undefined> = {
  solid: undefined,
  dashed: "6 4",
  dotted: "1 4",
  dashDot: "8 4 1 4",
};
const DASH_ORDER: readonly TrendDash[] = ["solid", "dashed", "dotted", "dashDot"];

export interface TrendSeries {
  key: string;
  label: string;
  color: `--chart-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
  /** Line charts: the stroke pattern; defaults by position (solid, dashed, dotted, dash-dot). */
  dash?: TrendDash;
}
export interface TrendChartProps extends Omit<React.ComponentProps<"div">, "children"> {
  data: Record<string, string | number>[];
  series: TrendSeries[];
  xKey: string;
  ariaLabel: string;
  type?: "bar" | "line";
  compact?: boolean;
  grouped?: boolean;
  /** A key-only `Legend` of the series above or below the chart; the other props stay on the chart. */
  legend?: "top" | "bottom";
  /** Line charts: each series' name at its last point, so a line is named where it ends. */
  directLabels?: boolean;
  /** Default true. Counts of people want whole ticks (no "0.25 viewers"). */
  allowDecimals?: boolean;
  /** Formats the axis ticks and the tooltip values (money in cents, hours); default: the number. */
  formatValue?: (value: number) => string;
}

/** The stroke pattern a line series draws with (its own, or by position). */
function dashOf(item: TrendSeries, index: number): TrendDash {
  return item.dash ?? DASH_ORDER[index % DASH_ORDER.length] ?? "solid";
}
export function TrendChart({
  data,
  series,
  xKey,
  ariaLabel,
  type = "line",
  compact = false,
  grouped = false,
  legend,
  directLabels = false,
  allowDecimals = true,
  formatValue,
  className,
  ...props
}: TrendChartProps) {
  const config: ChartConfig = Object.fromEntries(
    series.map((item) => [item.key, { label: item.label, color: `var(${item.color})` }]),
  );
  const common = {
    data,
    accessibilityLayer: true,
    margin: compact
      ? { top: 2, right: 2, bottom: 2, left: 2 }
      : { top: 8, right: directLabels && type === "line" ? 72 : 8, bottom: 0, left: 0 },
  };
  const label = (key: string) => series.find((item) => item.key === key)?.label ?? key;
  const tooltip = (
    <Tooltip
      content={
        <ChartTooltipContent
          formatter={
            formatValue
              ? (value, name) => (
                  <span className="flex w-full justify-between gap-3">
                    <span className="text-muted-foreground">{label(String(name))}</span>
                    <span className="font-medium text-foreground tabular-nums">{formatValue(Number(value))}</span>
                  </span>
                )
              : undefined
          }
        />
      }
    />
  );
  const yAxis = (
    <YAxis
      tickLine={false}
      axisLine={false}
      allowDecimals={allowDecimals}
      tickFormatter={formatValue ? (value: number) => formatValue(value) : undefined}
    />
  );
  const chart = (
    <ChartContainer
      config={config}
      role="img"
      aria-label={ariaLabel}
      className={cn("aspect-auto h-64 w-full", compact && "h-12", className)}
      {...props}
    >
      {type === "bar" ? (
        <BarChart {...common} barGap={grouped ? 4 : 0}>
          {tooltip}
          {!compact ? (
            <>
              <CartesianGrid vertical={false} />
              <XAxis dataKey={xKey} tickLine={false} axisLine={false} />
              {yAxis}
            </>
          ) : null}
          {series.map((item) => (
            <Bar key={item.key} dataKey={item.key} fill={`var(${item.color})`} isAnimationActive={false} />
          ))}
        </BarChart>
      ) : (
        <LineChart {...common}>
          {tooltip}
          {!compact ? (
            <>
              <CartesianGrid vertical={false} />
              <XAxis dataKey={xKey} tickLine={false} axisLine={false} />
              {yAxis}
            </>
          ) : null}
          {series.map((item, index) => (
            <Line
              key={item.key}
              dataKey={item.key}
              name={item.label}
              type="monotone"
              stroke={`var(${item.color})`}
              strokeWidth={2}
              strokeDasharray={DASH_ARRAY[dashOf(item, index)]}
              dot={false}
              isAnimationActive={false}
            >
              {directLabels && !compact ? (
                <LabelList
                  dataKey={item.key}
                  content={(label) => {
                    // Only the last point carries the name.
                    if (label.index !== data.length - 1) return null;
                    const x = Number(label.x ?? 0);
                    const y = Number(label.y ?? 0);
                    return (
                      <text x={x + 6} y={y} dy={4} className="fill-foreground text-xs">
                        {item.label}
                      </text>
                    );
                  }}
                />
              ) : null}
            </Line>
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
  if (!legend) return chart;
  const key = (
    <Legend
      layout="inline"
      items={series.map((item, index) => ({
        id: item.key,
        label: item.label,
        color: item.color,
        // A line chart's key draws each series' stroke pattern; bars keep the swatch.
        ...(type === "line" ? { dash: dashOf(item, index) } : {}),
      }))}
    />
  );
  return (
    <div data-slot="trend-chart" className="flex min-w-0 flex-col gap-3">
      {legend === "top" ? key : null}
      {chart}
      {legend === "bottom" ? key : null}
    </div>
  );
}
