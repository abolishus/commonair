// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "@commonair/ui/lib/utils";
import { toEpochMs, useRequestNow } from "../../lib/now.tsx";
import { RelativeTime } from "../../primitives/relative-time.tsx";
import { StatusBadge, type StatusTone } from "../../primitives/status-badge.tsx";

export interface DeadlineCountdownProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** ISO 8601 string (as on the wire), `Date`, or epoch milliseconds. */
  deadline: string | Date | number;
  /** Badge text while time remains ("Due"). */
  dueLabel: string;
  /** Badge text once the deadline passed ("Overdue"). */
  overdueLabel: string;
  /** Turns the badge to warning when this close to the deadline. */
  warnWithinMs?: number;
  /** Reference time for tests and the server render; the live clock takes over after mount. */
  now?: number | Date | string;
}

const TICK_MS = 30_000;

export function deadlineTone(deadlineMs: number, nowMs: number, warnWithinMs: number): StatusTone {
  const left = deadlineMs - nowMs;
  if (left <= 0) return "danger";
  if (left <= warnWithinMs) return "warning";
  return "info";
}

/**
 * A response deadline (SLA, legal clock): a status badge that turns warning, then danger, as it
 * nears and passes, next to the relative time. The tone is never the only signal: the label says
 * "due" or "overdue" and the time is in a `<time>` element.
 */
export function DeadlineCountdown({
  deadline,
  dueLabel,
  overdueLabel,
  warnWithinMs = 60 * 60 * 1000,
  now: nowProp,
  className,
  ...props
}: DeadlineCountdownProps): React.JSX.Element {
  const requestNow = useRequestNow();
  const [clock, setClock] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (nowProp !== undefined) return;
    const id = setInterval(() => setClock(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [nowProp]);
  const deadlineMs = toEpochMs(deadline);
  const now = nowProp !== undefined ? toEpochMs(nowProp) : (clock ?? requestNow ?? deadlineMs - 1);
  const tone = deadlineTone(deadlineMs, now, warnWithinMs);
  return (
    <span
      data-slot="deadline-countdown"
      data-tone={tone}
      className={cn("inline-flex flex-wrap items-center gap-2", className)}
      {...props}
    >
      <StatusBadge tone={tone} suppressHydrationWarning>
        {tone === "danger" ? overdueLabel : dueLabel}
      </StatusBadge>
      <RelativeTime date={deadline} now={nowProp ?? requestNow} className="text-xs text-muted-foreground" />
    </span>
  );
}
