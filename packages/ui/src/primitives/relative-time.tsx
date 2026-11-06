// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip.tsx";
import { formatDateTime, formatDuration, formatIsoDuration, formatRelativeTime } from "../lib/format.ts";
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
  /**
   * `"relative"` (default): "5 minutes ago". `"elapsed"`: the time since `date` as a running clock
   * ("4:05", "1:02:03", hours never roll into days), ticking every second while `live`; the
   * `<time dateTime>` is then the ISO duration and the tooltip still the absolute start.
   */
  mode?: "relative" | "elapsed";
}

const noopSubscribe = (): (() => void) => () => {};
const isClient = (): boolean => true;
const isServer = (): boolean => false;

const subscribeSeconds = (tick: () => void): (() => void) => {
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
};
// Whole seconds, so repeated reads within one render (and one second) agree.
const currentSecond = (): number => Math.floor(Date.now() / 1000) * 1000;

/**
 * The clock for the elapsed mode, re-read once a second while `ticking`. The server render and
 * hydration use `initial` so they match; a client-only render (a client-side navigation, when the
 * request time is long stale) starts from the real clock. Reading `Date.now()` at render, not in
 * the timer, means a late or throttled tick still shows the right time.
 */
function useSecondClock(ticking: boolean, initial: number | undefined): number {
  const [mountedAt] = React.useState(currentSecond);
  const fixed = initial ?? mountedAt;
  return React.useSyncExternalStore(
    ticking ? subscribeSeconds : noopSubscribe,
    ticking ? currentSecond : () => fixed,
    () => fixed,
  );
}

function toDate(value: string | Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * "5 minutes ago" in a `<time dateTime>` element that re-renders exactly when its
 * text would change, with the absolute time in a tooltip. `mode="elapsed"` shows the time since
 * `date` as a clock instead (a broadcast's uptime).
 */
export function RelativeTime({
  date,
  locale,
  timeZone,
  live = true,
  tooltip = true,
  now: nowProp,
  mode = "relative",
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

  const elapsed = mode === "elapsed";
  const secondClock = useSecondClock(elapsed && live, initialNow);
  const elapsedSeconds = valid ? Math.max(0, Math.floor((secondClock - parsed.getTime()) / 1000)) : 0;

  const result = !valid
    ? { text: "", nextUpdateMs: null }
    : elapsed
      ? { text: formatDuration(elapsedSeconds), nextUpdateMs: null }
      : formatRelativeTime(parsed, now, resolvedLocale);

  React.useEffect(() => {
    if (!live || result.nextUpdateMs === null) return;
    const id = setTimeout(() => setClock(Date.now()), result.nextUpdateMs);
    return () => clearTimeout(id);
  }, [live, result.nextUpdateMs, now]);

  if (!valid) return <time className={className} {...props} />;

  const element = (
    <time
      data-slot="relative-time"
      data-mode={mode}
      dateTime={elapsed ? formatIsoDuration(elapsedSeconds) : parsed.toISOString()}
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
