// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip.tsx";
import { formatDateTime, formatRelativeTime } from "../lib/format.ts";
import { useLocale } from "../lib/locale.tsx";
import { toEpochMs, useRequestNow } from "../lib/now.tsx";
import { cn } from "../lib/utils.ts";

export interface RelativeTimeProps extends Omit<React.ComponentProps<"time">, "children" | "dateTime"> {
  /** ISO 8601 string (as on the wire), `Date`, or epoch milliseconds. */
  date: string | Date | number;
  locale?: string;
  timeZone?: string;
  /** Re-render as time passes (default). Turn off for static lists such as exports. */
  live?: boolean;
  /**
   * The reference time for the server render and the first client render (hydration).
   * Defaults to `NowProvider`; after mount the live clock takes over.
   */
  now?: number | Date | string;
  /** Show the absolute time in a tooltip on hover/focus (default). */
  tooltip?: boolean;
}

const noopSubscribe = (): (() => void) => () => {};
const isClient = (): boolean => true;
const isServer = (): boolean => false;

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
  now: nowProp,
  className,
  ...props
}: RelativeTimeProps): React.JSX.Element {
  const ctx = useLocale();
  const resolvedLocale = locale ?? ctx.locale;
  const resolvedZone = timeZone ?? ctx.timeZone;
  const parsed = toDate(date);
  const valid = !Number.isNaN(parsed.getTime());
  const requestNow = useRequestNow();
  const initialNow = nowProp === undefined ? requestNow : toEpochMs(nowProp);
  // False on the server and during hydration, true afterwards: until then render with the
  // request time so server and client markup match, then switch to the live clock.
  const hydrated = React.useSyncExternalStore(noopSubscribe, isClient, isServer);
  const [clock, setClock] = React.useState(() => Date.now());
  const useRequestTime = initialNow !== undefined && (!hydrated || !live);
  const now = useRequestTime ? initialNow : clock;

  const result = valid ? formatRelativeTime(parsed, now, resolvedLocale) : { text: "", nextUpdateMs: null };

  React.useEffect(() => {
    if (!live || result.nextUpdateMs === null) return;
    const id = setTimeout(() => setClock(Date.now()), result.nextUpdateMs);
    return () => clearTimeout(id);
  }, [live, result.nextUpdateMs, now]);

  if (!valid) return <time className={className} {...props} />;

  const element = (
    <time
      data-slot="relative-time"
      dateTime={parsed.toISOString()}
      // The text may legitimately differ from the server render by the time the client hydrates.
      suppressHydrationWarning
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
