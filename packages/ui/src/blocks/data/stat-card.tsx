// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "@commonair/ui/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";

export type StatDelta = { direction: "up" | "down" | "flat"; label: string; sentiment?: "positive" | "negative" };
export interface StatCardProps extends Omit<React.ComponentProps<"div">, "title"> {
  label: string;
  value: React.ReactNode;
  delta?: StatDelta;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  /** Under the value and hint, inside the card: a progress bar, a link, a small breakdown. */
  footer?: React.ReactNode;
  size?: "default" | "sm";
  tone?: "default" | "accent" | "success" | "warning";
}

export function StatCard({
  label,
  value,
  delta,
  hint,
  icon,
  footer,
  size = "default",
  tone = "default",
  className,
  ...props
}: StatCardProps) {
  const sentimentClass =
    delta?.sentiment === "positive"
      ? "text-success"
      : delta?.sentiment === "negative"
        ? "text-destructive"
        : "text-muted-foreground";
  const toneClass = {
    default: "",
    accent: "bg-channel-accent text-channel-accent-foreground",
    success: "bg-success/10",
    warning: "bg-warning/10",
  }[tone];
  return (
    <Card size={size} data-tone={tone} className={cn("min-w-0", toneClass, className)} {...props}>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle className="text-muted-foreground">{label}</CardTitle>
        {icon ? (
          <span aria-hidden="true" className="text-muted-foreground">
            {icon}
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-1">
        <div className="break-words text-lg font-semibold tabular-nums">{value}</div>
        {delta ? <p className={cn("text-xs", sentimentClass)}>{delta.label}</p> : null}
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {footer ? (
          <div data-slot="stat-card-footer" className="mt-1 flex flex-col gap-2">
            {footer}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface StatGridProps extends React.ComponentProps<"div"> {
  cols?: 2 | 3 | 4 | 6;
}
export function StatGrid({ cols = 3, className, ...props }: StatGridProps) {
  const columns = {
    2: "grid-cols-2",
    3: "grid-cols-2 md:grid-cols-3",
    4: "grid-cols-2 md:grid-cols-4",
    6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
  }[cols];
  return <div className={cn("grid gap-3", columns, className)} {...props} />;
}
