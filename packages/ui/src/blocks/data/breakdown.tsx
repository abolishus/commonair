// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Data visualizations use the required accessible image role. */

import * as React from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { ChartContainer, type ChartConfig } from "@commonair/ui/components/chart";
import { StatusBadge } from "../../primitives/status-badge.tsx";
import { cn } from "@commonair/ui/lib/utils";

export type ChartColor = `--chart-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
export interface BreakdownSegment {
  id: string;
  label: string;
  value: number;
  color?: ChartColor;
}
/** Status tokens a key-only legend may use (e.g. an uptime strip's operational / degraded / outage). */
export type LegendStatusColor = "--success" | "--warning" | "--destructive" | "--info" | "--muted";
/** A legend entry; without `value` it is a key only (swatch + label). */
export interface LegendItem {
  id: string;
  label: string;
  value?: number;
  color?: ChartColor | LegendStatusColor;
}
export interface LegendProps extends React.ComponentProps<"ul"> {
  items: LegendItem[];
  layout?: "inline" | "list";
  formatValue?: (value: number) => React.ReactNode;
  formatShare?: (share: number) => React.ReactNode;
}
export function getSegmentShares(segments: BreakdownSegment[]): number[] {
  const total = segments.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (total === 0) return segments.map(() => 0);
  const raw = segments.map((item) => (Math.max(0, item.value) / total) * 100);
  const integerShares = raw.map(Math.floor);
  let remainder = 100 - integerShares.reduce((a, b) => a + b, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < remainder; i++) {
    const slot = order[i];
    if (slot) integerShares[slot.index] = (integerShares[slot.index] ?? 0) + 1;
  }
  return integerShares;
}
export function Legend({
  items,
  layout = "list",
  formatValue = String,
  formatShare = (value) => `${value}%`,
  className,
  ...props
}: LegendProps) {
  // Key-only items count as zero, so shares are over the items that carry a value.
  const shares = getSegmentShares(items.map((item) => ({ id: item.id, label: item.label, value: item.value ?? 0 })));
  return (
    <ul className={cn("flex gap-x-4 gap-y-2", layout === "list" ? "flex-col" : "flex-wrap", className)} {...props}>
      {items.map((item, index) => (
        <li
          key={item.id}
          data-key-only={item.value === undefined || undefined}
          className="flex min-w-0 items-center gap-2 text-xs"
        >
          <span
            aria-hidden="true"
            className="size-2 shrink-0 bg-(--segment-color)"
            style={{ "--segment-color": `var(${item.color ?? `--chart-${(index % 8) + 1}`})` } as React.CSSProperties}
          />
          <span className={cn("min-w-0", layout === "list" && "flex-1")}>{item.label}</span>
          {item.value === undefined ? null : (
            <span className="tabular-nums text-muted-foreground">
              {formatValue(item.value)} · {formatShare(shares[index] ?? 0)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
export interface BreakdownBarProps extends Omit<React.ComponentProps<"div">, "children"> {
  segments: BreakdownSegment[];
  label: string;
  formatLabel: (segments: BreakdownSegment[], shares: number[]) => string;
  formatValue?: (value: number) => React.ReactNode;
  showLegend?: boolean;
  legendLayout?: "inline" | "list";
}
export function BreakdownBar({
  segments,
  label,
  formatLabel,
  formatValue,
  showLegend = true,
  legendLayout = "list",
  className,
  ...props
}: BreakdownBarProps) {
  const shares = getSegmentShares(segments);
  const config: ChartConfig = Object.fromEntries(
    segments.map((segment, index) => [
      segment.id,
      { label: segment.label, color: `var(${segment.color ?? `--chart-${(index % 8) + 1}`})` },
    ]),
  );
  const data = [
    { name: label, ...Object.fromEntries(segments.map((segment) => [segment.id, Math.max(segment.value, 0)])) },
  ];
  return (
    <div className={cn("grid gap-3", className)} {...props}>
      <ChartContainer config={config} role="img" aria-label={formatLabel(segments, shares)} className="h-4 aspect-auto">
        <BarChart accessibilityLayer data={data} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis type="category" dataKey="name" hide />
          {segments.map((s, i) => (
            <Bar
              key={s.id}
              dataKey={s.id}
              stackId="share"
              fill={`var(${s.color ?? `--chart-${(i % 8) + 1}`})`}
              isAnimationActive={false}
              radius={0}
            />
          ))}
        </BarChart>
      </ChartContainer>
      {showLegend ? <Legend items={segments} layout={legendLayout} formatValue={formatValue} /> : null}
    </div>
  );
}
export interface BreakdownTallyProps {
  label: string;
  note: string;
  status: string;
  passed: boolean;
  segments: BreakdownSegment[];
  votesLabel: string;
  votes: number;
  formatLabel: BreakdownBarProps["formatLabel"];
}
export function BreakdownTally({
  label,
  note,
  status,
  passed,
  segments,
  votesLabel,
  votes,
  formatLabel,
}: BreakdownTallyProps) {
  return (
    <section className="grid gap-2">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{label}</h3>
        <StatusBadge tone={passed ? "success" : "warning"}>{status}</StatusBadge>
      </header>
      <p className="text-xs text-muted-foreground">{note}</p>
      <BreakdownBar segments={segments} label={label} formatLabel={formatLabel} showLegend={false} />
      <p className="text-xs text-muted-foreground tabular-nums">
        {votesLabel}: {votes.toLocaleString()}
      </p>
    </section>
  );
}
