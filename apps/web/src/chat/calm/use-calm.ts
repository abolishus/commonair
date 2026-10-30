// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Calm Chat for one panel: feeds every new message of the (already block-filtered) log through
 * the rate governor and the digest, and derives the rows to render with `calmRows`. The log
 * itself is never changed, so turning Calm Chat off shows every line. Turning it on keeps what is
 * already in the log (grouped into waves) and governs only what arrives afterwards.
 */
import * as React from "react";
import type { ChatRow } from "../state.ts";
import { Digest } from "./digest.ts";
import { RateGovernor, priorityOf } from "./governor.ts";
import { calmRows, groupMessages, isForMe, joinsShownWave, type CalmRow } from "./reducer.ts";

/** How often queued rows are let through (the governor's budget is per second). */
export const FLUSH_MS = 250;

export interface UseCalmOptions {
  rows: readonly ChatRow[];
  enabled: boolean;
  rowsPerSecond: number;
  subscriberPriority: boolean;
  self: string | null;
  /** The clock (tests pass a fake); read once, on mount. */
  now?: () => number;
}

export interface CalmView {
  /** Null when Calm Chat is off: render the raw log. */
  rows: CalmRow[] | null;
  /** The digest region's text ("" until the first update). */
  digest: string;
  toggleWave: (id: string) => void;
}

const messageIds = (rows: readonly ChatRow[]) => rows.flatMap((r) => (r.kind === "message" ? [r.id] : []));

export function useCalm({
  rows,
  enabled,
  rowsPerSecond,
  subscriberPriority,
  self,
  now = Date.now,
}: UseCalmOptions): CalmView {
  const [governor] = React.useState(() => new RateGovernor({ rowsPerSecond, now }));
  const [digester] = React.useState(() => new Digest({ now }));
  const [admitted, setAdmitted] = React.useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const [digest, setDigest] = React.useState("");
  const [wasEnabled, setWasEnabled] = React.useState(false);
  // Turning Calm Chat on: what is already in the log stays visible; only new lines are governed.
  if (enabled !== wasEnabled) {
    setWasEnabled(enabled);
    if (enabled) {
      setAdmitted(new Set(messageIds(rows)));
      setDigest("");
    }
  }

  const offered = React.useRef(new Set<string>());
  const senders = React.useRef(new Set<string>());
  const admittedRef = React.useRef(admitted);
  const rowsRef = React.useRef(rows);
  const governing = React.useRef(false);
  React.useEffect(() => {
    admittedRef.current = admitted;
    rowsRef.current = rows;
  });
  React.useEffect(() => {
    governor.setRate(rowsPerSecond);
  }, [governor, rowsPerSecond]);

  // New messages: count them for the digest and queue the ones that would add a row.
  React.useEffect(() => {
    if (enabled && !governing.current) {
      governing.current = true;
      for (const id of messageIds(rows)) offered.current.add(id);
      governor.reset();
      digester.reset();
      return;
    }
    governing.current = enabled;
    const fresh = rows.filter(
      (r): r is Extract<ChatRow, { kind: "message" }> => r.kind === "message" && !offered.current.has(r.id),
    );
    if (fresh.length === 0) return;
    const groups = enabled ? groupMessages(rows, { self }) : null;
    for (const r of fresh) {
      offered.current.add(r.id);
      const firstTime = !senders.current.has(r.message.user.id);
      senders.current.add(r.message.user.id);
      if (!groups) continue;
      digester.message(isForMe(r.message, self));
      const wave = groups.get(r.id);
      if (wave && wave.count >= 2) digester.wave(wave.id, wave.first.body, wave.count);
      // Joining a wave already on screen adds no row: its count grows from the log.
      if (!joinsShownWave(groups, r.id, (id) => admittedRef.current.has(id) || governor.isQueued(id)))
        governor.offer({ id: r.id, priority: priorityOf(r.message, { self, firstTime, subscriberPriority }) });
    }
  }, [rows, enabled, self, subscriberPriority, governor, digester]);

  // Let queued rows through on a short tick; publish the digest at most every interval.
  React.useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const { admitted: through, dropped } = governor.flush();
      if (dropped.length > 0) digester.hidden(dropped.length);
      const live = rowsRef.current;
      // Ids that left the capped log need not be remembered.
      if (offered.current.size > live.length * 2 + 50) {
        const ids = new Set(messageIds(live));
        offered.current = new Set([...offered.current].filter((id) => ids.has(id)));
        setAdmitted((prev) => new Set([...prev, ...through].filter((id) => ids.has(id))));
      } else if (through.length > 0) setAdmitted((prev) => new Set([...prev, ...through]));
      const text = digester.take();
      if (text !== null) setDigest(text);
    };
    const handle = setInterval(tick, FLUSH_MS);
    return () => clearInterval(handle);
  }, [enabled, governor, digester]);

  const toggleWave = React.useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const view = React.useMemo(
    () => (enabled ? calmRows(rows, { self, admitted, expanded }) : null),
    [enabled, rows, self, admitted, expanded],
  );
  return { rows: view, digest, toggleWave };
}
