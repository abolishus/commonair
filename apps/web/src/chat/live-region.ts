// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When the chat log stops announcing (D4.1): a `role=log` region is polite, but read aloud line by
 * line a busy chat drowns everything else. Above `BUSY_ROWS` new rows in `BUSY_WINDOW_MS` the log
 * goes quiet (`aria-live="off"`) until the room calms, the way Calm Chat hands the log to its
 * digest. The reader can still read the log; it just is not spoken over them.
 */
import * as React from "react";

export const BUSY_WINDOW_MS = 10_000;
export const BUSY_ROWS = 8;

/** Whether `times` (row arrival times, ms) hold more than `BUSY_ROWS` inside the window ending at `now`. */
export function isBusy(times: readonly number[], now: number): boolean {
  let n = 0;
  for (const at of times) if (now - at < BUSY_WINDOW_MS) n += 1;
  return n > BUSY_ROWS;
}

/** Tracks `rowSeq` (one tick per new row) and says whether the log is too busy to announce. */
export function useBusyLog(rowSeq: number, now: () => number = Date.now): boolean {
  const times = React.useRef<number[]>([]);
  const seen = React.useRef(rowSeq);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    const added = rowSeq - seen.current;
    seen.current = rowSeq;
    if (added <= 0) return;
    const at = now();
    const kept = times.current.filter((t) => at - t < BUSY_WINDOW_MS);
    for (let i = 0; i < Math.min(added, BUSY_ROWS + 1); i += 1) kept.push(at);
    times.current = kept;
    setBusy(isBusy(kept, at));
  }, [rowSeq, now]);
  // Calm again once the window passes without a new row.
  React.useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => setBusy(isBusy(times.current, now())), BUSY_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [busy, rowSeq, now]);
  return busy;
}
