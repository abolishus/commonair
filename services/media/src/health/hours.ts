// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live time per clock hour (UTC) for `stream_hours.liveSeconds`. Only this column is written by
 * media; eligibility and verified viewers are the integrity scorer's.
 */
import { sql } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";

const HOUR_MS = 3_600_000;

export interface HourSlice {
  hourStart: Date;
  /** Milliseconds of [from, to) that fall into this hour. */
  ms: number;
}

/** Split [fromMs, toMs) at UTC hour boundaries. */
export function splitByHour(fromMs: number, toMs: number): HourSlice[] {
  const out: HourSlice[] = [];
  let t = fromMs;
  while (t < toMs) {
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
    const end = Math.min(toMs, hour + HOUR_MS);
    out.push({ hourStart: new Date(hour), ms: end - t });
    t = end;
  }
  return out;
}

/**
 * Accumulates live milliseconds and flushes whole seconds, carrying the remainder so frequent
 * small ticks never lose time to rounding.
 */
export class LiveTimeAccumulator {
  private pending = new Map<number, number>();

  add(fromMs: number, toMs: number): void {
    for (const s of splitByHour(fromMs, toMs))
      this.pending.set(s.hourStart.getTime(), (this.pending.get(s.hourStart.getTime()) ?? 0) + s.ms);
  }

  /** Whole seconds per hour ready to write; the sub-second remainder stays pending. */
  take(): { hourStart: Date; seconds: number }[] {
    const out: { hourStart: Date; seconds: number }[] = [];
    for (const [hour, ms] of this.pending) {
      const seconds = Math.floor(ms / 1000);
      if (seconds <= 0) continue;
      out.push({ hourStart: new Date(hour), seconds });
      this.pending.set(hour, ms - seconds * 1000);
    }
    // Drop fully flushed past hours so the map stays small on long streams.
    const current = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    for (const [hour, ms] of this.pending) if (hour < current - HOUR_MS && ms < 1000) this.pending.delete(hour);
    return out;
  }

  /** Put seconds back after a failed write. */
  restore(rows: { hourStart: Date; seconds: number }[]): void {
    for (const r of rows)
      this.pending.set(r.hourStart.getTime(), (this.pending.get(r.hourStart.getTime()) ?? 0) + r.seconds * 1000);
  }
}

export async function addLiveSeconds(
  db: Executor,
  broadcastId: string,
  channelId: string,
  rows: { hourStart: Date; seconds: number }[],
): Promise<void> {
  if (rows.length === 0) return;
  const t = schema.streamHours;
  await db
    .insert(t)
    .values(
      rows.map((r) => ({ broadcastId, channelId, hourStart: r.hourStart, liveSeconds: Math.min(3600, r.seconds) })),
    )
    .onConflictDoUpdate({
      target: [t.broadcastId, t.hourStart],
      // An hour never holds more than 3600 live seconds, whatever restarts or clock skew do.
      set: { liveSeconds: sql`least(3600, ${t.liveSeconds} + excluded.live_seconds)` },
    });
}
