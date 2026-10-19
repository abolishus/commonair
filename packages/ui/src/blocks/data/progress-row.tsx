// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Progress, ProgressIndicator, ProgressTrack } from "@commonair/ui/components/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { cn } from "@commonair/ui/lib/utils";

export type ProgressTone = "default" | "accent" | "success" | "warning" | "danger";
export interface ProgressRowProps extends Omit<React.ComponentProps<"div">, "title"> {
  label: string;
  value: number;
  valueText: React.ReactNode;
  note?: React.ReactNode;
  noteTone?: ProgressTone;
  tone?: ProgressTone;
  minLabel?: string;
  maxLabel?: string;
}
export function ProgressRow({
  label,
  value,
  valueText,
  note,
  noteTone = "default",
  tone = "default",
  minLabel,
  maxLabel,
  className,
  ...props
}: ProgressRowProps) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const indicatorClass = {
    default: "bg-primary",
    accent: "bg-accent-foreground",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
  }[tone];
  const noteColor = {
    default: "text-muted-foreground",
    accent: "text-accent-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-destructive",
  }[noteTone];
  return (
    <div className={cn("grid gap-1.5", className)} {...props}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-xs tabular-nums">{valueText}</span>
      </div>
      <Progress
        aria-label={label}
        value={clamped}
        className="gap-0"
        // shadcn Progress always draws a default track; the render function swaps in the same parts
        // with the tone on the indicator (they read the root's context, which still wraps them).
        render={(rootProps) => (
          <div {...rootProps}>
            <ProgressTrack>
              <ProgressIndicator className={indicatorClass} />
            </ProgressTrack>
          </div>
        )}
      />
      {minLabel || maxLabel ? (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      ) : null}
      {note ? <p className={cn("text-xs", noteColor)}>{note}</p> : null}
    </div>
  );
}
export interface ProgressListProps extends React.ComponentProps<"div"> {
  rows: ProgressRowProps[];
}
export function ProgressList({ rows, className, ...props }: ProgressListProps) {
  return (
    <div className={cn("grid gap-4", className)} {...props}>
      {rows.map(({ label, ...row }) => (
        <ProgressRow key={label} label={label} {...row} />
      ))}
    </div>
  );
}

export interface PollOption {
  id: string;
  label: string;
  value: number;
  percent: number;
}
export interface PollCardProps extends Omit<React.ComponentProps<"div">, "title"> {
  question: string;
  timeLeft: string;
  totalVotes: string;
  options: PollOption[];
  voted?: boolean;
  closed?: boolean;
}
export function PollCard({
  question,
  timeLeft,
  totalVotes,
  options,
  voted = false,
  closed = false,
  className,
  ...props
}: PollCardProps) {
  return (
    <Card size="sm" className={className} {...props}>
      <CardHeader>
        <CardTitle>{question}</CardTitle>
        <p className="text-xs text-muted-foreground">{closed ? totalVotes : `${timeLeft} · ${totalVotes}`}</p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {options.map((option) => (
          <ProgressRow
            key={option.id}
            label={option.label}
            value={option.percent}
            valueText={`${option.percent}%`}
            note={voted || closed ? `${option.value.toLocaleString()}` : undefined}
          />
        ))}
      </CardContent>
    </Card>
  );
}
