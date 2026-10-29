// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

/**
 * `value`, changing at most once per `intervalMs`: the latest value lands when the interval
 * ends. For polite live regions over counts that change every second, so a screen reader is
 * not interrupted by every vote.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = React.useState(value);
  const last = React.useRef(0);
  React.useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = Math.max(0, last.current + intervalMs - Date.now());
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, shown, intervalMs]);
  return shown;
}

/** Whole percent of `part` in `total`, 0 when there is nothing to divide. */
export function percentOf(part: number, total: number): number {
  if (!(total > 0) || !(part > 0)) return 0;
  return Math.min(100, Math.round((part / total) * 100));
}
