// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Data visualizations use the required accessible image role. */

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipContent, type ChartConfig } from "@commonair/ui/components/chart";
import { cn } from "@commonair/ui/lib/utils";

export interface TrendSeries {
  key: string;
  label: string;
  color: `--chart-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
}
export interface TrendChartProps extends Omit<React.ComponentProps<"div">, "children"> {
  data: Record<string, string | number>[];
  series: TrendSeries[];
  xKey: string;
  ariaLabel: string;
  type?: "bar" | "line";
  compact?: boolean;
  grouped?: boolean;
}
export function TrendChart({
  data,
  series,
  xKey,
  ariaLabel,
  type = "line",
  compact = false,
  grouped = false,
  className,
  ...props
}: TrendChartProps) {
  const config: ChartConfig = Object.fromEntries(
    series.map((item) => [item.key, { label: item.label, color: `var(${item.color})` }]),
  );
  const common = {
    data,
    accessibilityLayer: true,
    margin: compact ? { top: 2, right: 2, bottom: 2, left: 2 } : { top: 8, right: 8, bottom: 0, left: 0 },
  };
  return (
    <ChartContainer
      config={config}
      role="img"
      aria-label={ariaLabel}
      className={cn("aspect-auto h-64 w-full", compact && "h-12", className)}
      {...props}
    >
      {type === "bar" ? (
        <BarChart {...common} barGap={grouped ? 4 : 0}>
          <Tooltip content={<ChartTooltipContent />} />
          {!compact ? (
            <>
              <CartesianGrid vertical={false} />
              <XAxis dataKey={xKey} tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} />
            </>
          ) : null}
          {series.map((item) => (
            <Bar key={item.key} dataKey={item.key} fill={`var(${item.color})`} isAnimationActive={false} />
          ))}
        </BarChart>
      ) : (
        <LineChart {...common}>
          <Tooltip content={<ChartTooltipContent />} />
          {!compact ? (
            <>
              <CartesianGrid vertical={false} />
              <XAxis dataKey={xKey} tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} />
            </>
          ) : null}
          {series.map((item) => (
            <Line
              key={item.key}
              dataKey={item.key}
              type="monotone"
              stroke={`var(${item.color})`}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}
