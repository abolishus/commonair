// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The growth page's small charts (overhaul wave 2, D2.8): a sparkline, a stat tile carrying one,
 * and the funnel's step bars. Values below the k floor arrive as null: a sparkline leaves a gap,
 * a tile and a step say "fewer than 5". Every chart is decoration over numbers shown as text.
 */
import { GROWTH_K_FLOOR } from "@commonair/contracts/enums";
import { formatInteger, formatPercent, useLocale } from "@commonair/ui";
import { ProgressRow, StatCard } from "@commonair/ui/blocks/data";
import { cn } from "@commonair/ui/lib/utils";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

/** A floored count as text: the number, or "fewer than 5" for a hidden one. */
export function flooredText(value: number | null, locale: string): string {
  return value === null ? t("d2Metrics.belowFloor", { floor: GROWTH_K_FLOOR }) : formatInteger(value, locale);
}

/**
 * SVG polyline segments for a series in a `width` × `height` box: one segment per run of known
 * values (a null breaks the line), scaled to the series' own maximum. A single known point draws
 * a short flat stroke so it stays visible.
 */
export function sparkSegments(values: readonly (number | null)[], width = 100, height = 24): string[] {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return [];
  const max = Math.max(...known, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (v: number) => Number((height - 1 - (v / max) * (height - 2)).toFixed(2));
  const x = (i: number) => Number((i * step).toFixed(2));
  const out: string[] = [];
  let run: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) out.push(run.length === 1 ? `${run[0]} ${run[0]}` : run.join(" "));
      run = [];
      return;
    }
    run.push(`${x(i)},${y(v)}`);
  });
  if (run.length) out.push(run.length === 1 ? `${run[0]} ${run[0]}` : run.join(" "));
  return out;
}

export function Sparkline({
  values,
  className,
}: {
  values: readonly (number | null)[];
  className?: string;
}): React.JSX.Element {
  const segments = sparkSegments(values);
  return (
    <svg
      data-testid="growth-sparkline"
      data-points={values.length}
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className={cn("h-6 w-full text-muted-foreground", className)}
    >
      {segments.map((points) => (
        <polyline
          key={points}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/** One metric: its total over the window, what it means, and its daily trend. */
export function GrowthStatTile({
  label,
  hint,
  value,
  series,
  ...props
}: {
  label: string;
  hint: string;
  value: number | null;
  series: readonly (number | null)[];
} & Record<`data-${string}`, string>): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <StatCard
      size="sm"
      label={label}
      value={<span data-floored={value === null ? "true" : undefined}>{flooredText(value, locale)}</span>}
      hint={hint}
      footer={<Sparkline values={series} />}
      {...props}
    />
  );
}

export interface FunnelStep {
  id: string;
  label: string;
  value: number | null;
}

/** Each step's share of the first step, 0–100; null when either count is hidden or the first is 0. */
export function stepShares(steps: readonly FunnelStep[]): (number | null)[] {
  const first = steps[0]?.value ?? null;
  return steps.map((s) => (first === null || first === 0 || s.value === null ? null : (s.value / first) * 100));
}

/** A funnel as step bars, each against the first step. Hidden counts draw an empty bar. */
export function FunnelBars({
  label,
  steps,
  className,
}: {
  label: string;
  steps: readonly FunnelStep[];
  className?: string;
}): React.JSX.Element {
  const { locale } = useLocale();
  const shares = stepShares(steps);
  return (
    <ol aria-label={label} className={cn("grid gap-4", className)}>
      {steps.map((step, i) => {
        const share = shares[i] ?? null;
        const count = flooredText(step.value, locale);
        return (
          <li key={step.id} data-testid="growth-funnel-step" data-step={step.id} data-value={step.value ?? "floored"}>
            <ProgressRow
              label={step.label}
              value={share ?? 0}
              valueText={
                share === null || i === 0
                  ? count
                  : t("d2Metrics.funnel.stepValue", {
                      count,
                      share: formatPercent(Math.min(share, 100) / 100, locale, { maximumFractionDigits: 1 }),
                    })
              }
            />
          </li>
        );
      })}
    </ol>
  );
}
