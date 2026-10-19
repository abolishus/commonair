// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Data visualizations use the required accessible image role. */

import * as React from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@commonair/ui/components/tooltip";
import { cn } from "@commonair/ui/lib/utils";

export interface UptimeDay {
  id: string;
  date: string;
  status: "ok" | "degraded" | "outage" | "none";
}
export interface UptimeStripProps extends Omit<React.ComponentProps<"div">, "children"> {
  days: UptimeDay[];
  label: string;
  daysOnMobile?: number;
  statusLabels: Record<UptimeDay["status"], string>;
}
export function UptimeStrip({ days, label, daysOnMobile = 30, statusLabels, className, ...props }: UptimeStripProps) {
  return (
    <TooltipProvider>
      <div role="img" aria-label={label} className={cn("flex gap-0.5", className)} {...props}>
        {days.map((day, index) => (
          <Tooltip key={day.id}>
            <TooltipTrigger
              aria-label={`${day.date}: ${statusLabels[day.status]}`}
              className={cn(
                "h-5 min-w-0 flex-1 bg-muted",
                day.status === "ok" && "bg-success",
                day.status === "degraded" && "bg-warning",
                day.status === "outage" && "bg-destructive",
                index < days.length - daysOnMobile && "hidden sm:block",
              )}
              data-status={day.status}
            />
            <TooltipContent>
              {day.date}: {statusLabels[day.status]}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
