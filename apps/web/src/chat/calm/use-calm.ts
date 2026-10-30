// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Calm Chat for one panel: feeds every new message of the (already block-filtered) log through
 * the rate governor and the digest, and derives the rows to render with `calmRows`. The log
 * itself is never changed, so turning Calm Chat off shows every line. Turning it on keeps what is
 * already in the log (grouped into waves) and governs only what arrives afterwards. A message that
 * joins a wave already on screen is admitted with it, and each wave keeps the id it was first
 * shown under, so the log's cap dropping a wave's oldest copies neither hides it nor makes it a
 * new row.
 */
import * as React from "react";
import type { ChatRow } from "../state.ts";
import { Digest } from "./digest.ts";
import { RateGovernor, priorityOf } from "./governor.ts";
import { calmRows, groupMessages, isForMe, joinsShownWave, type CalmRow, type Wave } from "./reducer.ts";

/** How often queued rows are let through (the governor's budget is per second). */
export const FLUSH_MS = 250;

export interface UseCalmOptions {
  /** The log as shown: blocked users' messages already removed. */
  rows: readonly ChatRow[];
  /**
   * The whole log, blocked users included: their messages count as seen, so an unblock does not
   * bring old lines back as new ones. Omitted: `rows`.
   */
  log?: readonly ChatRow[];
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

/** Senders remembered for "first-time chatter"; the oldest are forgotten past this. */
const MAX_SENDERS = 5_000;

function sameEntries(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

/** Remember the wave id of every grouped message that has none yet (see `CalmContext.waveIds`). */
function rememberWaves(groups: ReadonlyMap<string, Wave>, waveIds: Map<string, string>): void {
  for (const [id, wave] of groups) if (wave.count >= 2 && !waveIds.has(id)) waveIds.set(id, wave.id);
}

export function useCalm({
  rows,
  log = rows,
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
  // The effect keeps `waveIds` current; the tick publishes a copy for rendering.
  const waveIds = React.useRef(new Map<string, string>());
  const [shownWaveIds, setShownWaveIds] = React.useState<ReadonlyMap<string, string>>(() => new Map());
  // Copies that joined a shown wave, admitted with the next tick.
  const joined = React.useRef<string[]>([]);
  const admittedRef = React.useRef(admitted);
  const rowsRef = React.useRef(rows);
  const selfRef = React.useRef(self);
  const governing = React.useRef(false);
  React.useEffect(() => {
    admittedRef.current = admitted;
    rowsRef.current = rows;
    selfRef.current = self;
  });
  React.useEffect(() => {
    governor.setRate(rowsPerSecond);
  }, [governor, rowsPerSecond]);

  // New messages: count them for the digest and queue the ones that would add a row.
  React.useEffect(() => {
    // Blocked users' messages count as seen (an unblock must not replay them as new).
    if (log !== rows) {
      const shown = new Set(messageIds(rows));
      for (const id of messageIds(log)) if (!shown.has(id)) offered.current.add(id);
    }
    // Ids that left the capped log need not be remembered (in either mode).
    if (offered.current.size > log.length * 2 + 50) {
      const live = new Set(messageIds(log));
      offered.current = new Set([...offered.current].filter((id) => live.has(id)));
      for (const id of waveIds.current.keys()) if (!live.has(id)) waveIds.current.delete(id);
    }
    if (enabled && !governing.current) {
      governing.current = true;
      for (const id of messageIds(rows)) offered.current.add(id);
      rememberWaves(groupMessages(rows, { self, waveIds: waveIds.current }), waveIds.current);
      governor.reset();
      digester.reset();
      return;
    }
    governing.current = enabled;
    const fresh = rows.filter(
      (r): r is Extract<ChatRow, { kind: "message" }> => r.kind === "message" && !offered.current.has(r.id),
    );
    if (fresh.length === 0) return;
    const groups = enabled ? groupMessages(rows, { self, waveIds: waveIds.current }) : null;
    if (groups) rememberWaves(groups, waveIds.current);
    for (const r of fresh) {
      offered.current.add(r.id);
      const firstTime = !senders.current.has(r.message.user.id);
      senders.current.add(r.message.user.id);
      if (senders.current.size > MAX_SENDERS) {
        const oldest = senders.current.values().next();
        if (!oldest.done) senders.current.delete(oldest.value);
      }
      if (!groups) continue;
      digester.message(isForMe(r.message, self));
      const wave = groups.get(r.id);
      if (wave && wave.count >= 2) digester.wave(wave.id, wave.first.body, wave.count);
      // Joining a wave already on screen adds no row, only to its count; it is admitted with the
      // wave so the wave stays shown after the cap drops its older copies. Joining one that waits
      // for the governor rides with it (the flush admits the whole wave).
      if (joinsShownWave(groups, r.id, (id) => admittedRef.current.has(id))) joined.current.push(r.id);
      else if (!joinsShownWave(groups, r.id, (id) => governor.isQueued(id)))
        governor.offer({ id: r.id, priority: priorityOf(r.message, { self, firstTime, subscriberPriority }) });
    }
  }, [rows, log, enabled, self, subscriberPriority, governor, digester]);

  // Let queued rows through on a short tick; publish the digest at most every interval.
  React.useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const { admitted: flushed, dropped } = governor.flush();
      if (dropped.length > 0) digester.hidden(dropped.length);
      const live = rowsRef.current;
      // A wave let through brings the copies that joined it while it waited.
      let through = joined.current.splice(0);
      if (flushed.length > 0) {
        const groups = groupMessages(live, { self: selfRef.current, waveIds: waveIds.current });
        through = [
          ...new Set([...through, ...flushed.flatMap((id) => groups.get(id)?.messages.map((m) => m.id) ?? [id])]),
        ];
      }
      setShownWaveIds((prev) => (sameEntries(prev, waveIds.current) ? prev : new Map(waveIds.current)));
      // Admitted ids that left the capped log need not be remembered.
      if (admittedRef.current.size > live.length * 2 + 50) {
        const ids = new Set(messageIds(live));
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
    () => (enabled ? calmRows(rows, { self, admitted, expanded, waveIds: shownWaveIds }) : null),
    [enabled, rows, self, admitted, expanded, shownWaveIds],
  );
  return { rows: view, digest, toggleWave };
}
