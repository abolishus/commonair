// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@commonair/ui/components/tooltip";
import { cn } from "@commonair/ui/lib/utils";

export interface UptimeDay {
  id: string;
  date: string;
  status: "ok" | "degraded" | "outage" | "none";
}
export interface UptimeStripProps extends Omit<React.ComponentProps<"ul">, "children"> {
  days: UptimeDay[];
  /** Accessible name of the list ("API daily status, last 90 days"). */
  label: string;
  daysOnMobile?: number;
  statusLabels: Record<UptimeDay["status"], string>;
}
/**
 * One bar per day. A labelled list, not an image: every day is a focusable tooltip trigger whose
 * name says its date and status, so keyboard and screen-reader users can read each day.
 */
export function UptimeStrip({ days, label, daysOnMobile = 30, statusLabels, className, ...props }: UptimeStripProps) {
  return (
    <TooltipProvider>
      <ul aria-label={label} className={cn("flex gap-0.5", className)} {...props}>
        {days.map((day, index) => (
          <li
            key={day.id}
            className={cn("flex min-w-0 flex-1", index < days.length - daysOnMobile && "hidden sm:flex")}
          >
            <Tooltip>
              <TooltipTrigger
                aria-label={`${day.date}: ${statusLabels[day.status]}`}
                className={cn(
                  "h-5 w-full min-w-0 bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  day.status === "ok" && "bg-success",
                  day.status === "degraded" && "bg-warning",
                  day.status === "outage" && "bg-destructive",
                )}
                data-status={day.status}
              />
              <TooltipContent>
                {day.date}: {statusLabels[day.status]}
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
    </TooltipProvider>
  );
}
