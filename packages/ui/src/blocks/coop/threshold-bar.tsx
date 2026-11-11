// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "@commonair/ui/lib/utils";

export type ThresholdBarTone = "default" | "success" | "danger";

export interface ThresholdBarProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** What the bar measures ("Turnout", "Yes among streamers"). */
  label: React.ReactNode;
  /** The measured share, a fraction from 0 to 1 (clamped). */
  value: number;
  /** The share needed, a fraction; null or undefined draws no tick. */
  threshold?: number | null;
  /** The value in words ("31% · 70 of 226"); the bar itself is decorative. */
  valueText: React.ReactNode;
  /** The threshold in words ("10% needed"): the text equivalent of the tick. */
  thresholdText?: React.ReactNode;
  /** Pass/fail colour on decided results; the words always say it too. */
  tone?: ThresholdBarTone;
}

const clamp = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

const FILL: Record<ThresholdBarTone, string> = {
  default: "fill-muted-foreground",
  success: "fill-success",
  danger: "fill-destructive",
};

/**
 * A share against the share it needs (overhaul D6.2): participation with a quorum tick, a result
 * with its threshold tick. Drawn as SVG geometry (no inline style); the tick runs past the bar so
 * it reads on the track, on the fill and on the page. The label, value and threshold are text, so
 * the bar is `aria-hidden` and never the only signal.
 */
export function ThresholdBar({
  label,
  value,
  threshold,
  valueText,
  thresholdText,
  tone = "default",
  className,
  ...props
}: ThresholdBarProps): React.JSX.Element {
  const width = clamp(value) * 100;
  const tick = threshold === null || threshold === undefined ? null : clamp(threshold) * 100;
  return (
    <div
      data-slot="threshold-bar"
      data-value={String(clamp(value))}
      data-threshold={tick === null ? "" : String(clamp(threshold ?? 0))}
      className={cn("grid min-w-0 gap-1.5", className)}
      {...props}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{valueText}</span>
      </div>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        className="h-2.5 w-full overflow-visible"
      >
        <rect x="0" y="2" width="100" height="6" className="fill-muted" />
        <rect x="0" y="2" width={width} height="6" className={FILL[tone]} />
        {tick === null ? null : (
          <line
            data-slot="threshold-tick"
            x1={tick}
            x2={tick}
            y1="0"
            y2="10"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            className="stroke-foreground"
          />
        )}
      </svg>
      {thresholdText ? <p className="text-xs text-muted-foreground">{thresholdText}</p> : null}
    </div>
  );
}
