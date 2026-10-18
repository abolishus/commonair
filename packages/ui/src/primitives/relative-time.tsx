// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip.tsx";
import { formatDateTime, formatRelativeTime } from "../lib/format.ts";
import { useLocale } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";

export interface RelativeTimeProps extends Omit<React.ComponentProps<"time">, "children" | "dateTime"> {
  /** ISO 8601 string (as on the wire), `Date`, or epoch milliseconds. */
  date: string | Date | number;
  locale?: string;
  timeZone?: string;
  /** Re-render as time passes (default). Turn off for static lists such as exports. */
  live?: boolean;
  /** Show the absolute time in a tooltip on hover/focus (default). */
  tooltip?: boolean;
}

function toDate(value: string | Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * "5 minutes ago" in a `<time dateTime>` element that re-renders exactly when its
 * text would change, with the absolute time in a tooltip.
 */
export function RelativeTime({
  date,
  locale,
  timeZone,
  live = true,
  tooltip = true,
  className,
  ...props
}: RelativeTimeProps): React.JSX.Element {
  const ctx = useLocale();
  const resolvedLocale = locale ?? ctx.locale;
  const resolvedZone = timeZone ?? ctx.timeZone;
  const parsed = toDate(date);
  const valid = !Number.isNaN(parsed.getTime());
  const [now, setNow] = React.useState(() => Date.now());

  const result = valid ? formatRelativeTime(parsed, now, resolvedLocale) : { text: "", nextUpdateMs: null };

  React.useEffect(() => {
    if (!live || result.nextUpdateMs === null) return;
    const id = setTimeout(() => setNow(Date.now()), result.nextUpdateMs);
    return () => clearTimeout(id);
  }, [live, result.nextUpdateMs, now]);

  if (!valid) return <time className={className} {...props} />;

  const element = (
    <time
      data-slot="relative-time"
      dateTime={parsed.toISOString()}
      className={cn("tabular-nums", className)}
      {...props}
    >
      {result.text}
    </time>
  );
  if (!tooltip) return element;
  return (
    <Tooltip>
      <TooltipTrigger render={element} />
      <TooltipContent>{formatDateTime(parsed, resolvedLocale, resolvedZone)}</TooltipContent>
    </Tooltip>
  );
}
