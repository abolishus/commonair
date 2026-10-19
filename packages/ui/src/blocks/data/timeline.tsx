// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "@commonair/ui/lib/utils";
import { StatusBadge } from "../../primitives/status-badge.tsx";

export interface TimelineStep {
  id: string;
  label: string;
  meta?: React.ReactNode;
  state: "done" | "current" | "upcoming";
}
export interface TimelineUpdate {
  id: string;
  status: string;
  time: React.ReactNode;
  text: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}
export interface TimelineProps extends React.ComponentProps<"ol"> {
  steps?: TimelineStep[];
  updates?: TimelineUpdate[];
}
export function Timeline({ steps, updates, className, ...props }: TimelineProps) {
  if (updates)
    return (
      <ol className={cn("flex flex-col gap-3", className)} {...props}>
        {updates.map((item) => (
          <li key={item.id} className="flex min-w-0 items-start gap-3 border-l pl-3">
            <StatusBadge tone={item.tone} className="shrink-0">
              {item.status}
            </StatusBadge>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <time className="text-xs text-muted-foreground">{item.time}</time>
              <p className="text-xs">{item.text}</p>
            </div>
          </li>
        ))}
      </ol>
    );
  return (
    <ol className={cn("flex flex-col gap-3", className)} {...props}>
      {(steps ?? []).map((step) => (
        <li key={step.id} data-state={step.state} className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-5 shrink-0 items-center justify-center border text-xs",
              step.state === "done" && "bg-primary text-primary-foreground",
              step.state === "current" && "border-primary text-primary",
            )}
          >
            {step.state === "done" ? "✓" : step.state === "current" ? "•" : ""}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-medium">{step.label}</span>
            {step.meta ? <span className="text-xs text-muted-foreground">{step.meta}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
