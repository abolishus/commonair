// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Concurrency for the `device_concurrency` / `account_concurrency` signals.
 *
 * A reload (or a player re-creating its session) briefly leaves two sessions for the same
 * device and channel: the old one has stopped heartbeating, the new one is the real one.
 * The old session is **superseded** when a newer session of the same device and channel
 * started at or after its last heartbeat (minus a small slack) and it has stayed silent for
 * `graceMs` since, and its last heartbeat was visible. Superseded sessions neither count
 * toward concurrency nor fire; the job ends them. Two tabs that both keep heartbeating are
 * genuinely concurrent.
 *
 * Remaining live sessions are ranked newest first per device and per account.
 */
import type { Concurrency } from "./types.ts";

export interface LiveSession {
  id: string;
  deviceHash: string;
  userId: string | null;
  channelId: string;
  startedAt: Date;
  /** Last heartbeat, or the start time before the first one. */
  lastSeenAt: Date;
}

export interface SupersedeOptions {
  /** A newer session must have existed this long without the old one beating. */
  graceMs: number;
  /** Tolerance for a final beat racing the new session's start. */
  slackMs: number;
}

/**
 * 9 heartbeat intervals (10 s each), above the 60 s a throttled background tab may wait
 * between timer runs: a live tab would have beaten by then.
 */
export const SUPERSEDE_DEFAULTS: SupersedeOptions = { graceMs: 90_000, slackMs: 2_000 };

const byStart = (a: LiveSession, b: LiveSession) =>
  a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function groupBy<T>(xs: readonly T[], key: (x: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(x);
    else out.set(k, [x]);
  }
  return out;
}

/**
 * Ids of sessions replaced by a newer session of the same device and channel. Sessions in
 * `hidden` (last heartbeat reported `visible: false`) are never superseded: a background tab
 * goes quiet because the browser throttles it, not because it was replaced.
 */
export function findSuperseded(
  live: readonly LiveSession[],
  now: Date,
  opts: SupersedeOptions = SUPERSEDE_DEFAULTS,
  hidden: ReadonlySet<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  const settled = now.getTime() - opts.graceMs;
  for (const group of groupBy(live, (s) => `${s.deviceHash}\u0000${s.channelId}`).values()) {
    if (group.length < 2) continue;
    group.sort(byStart);
    for (let i = 0; i < group.length - 1; i++) {
      const a = group[i]!;
      if (hidden.has(a.id)) continue;
      const silentSince = a.lastSeenAt.getTime() - opts.slackMs;
      const replaced = group
        .slice(i + 1)
        .some((b) => b.startedAt.getTime() >= silentSince && b.startedAt.getTime() <= settled);
      if (replaced) out.add(a.id);
    }
  }
  return out;
}

export interface SessionConcurrency {
  device: Concurrency;
  /** Null for anonymous sessions. */
  account: Concurrency | null;
}

/** Newest-first rank per device and per account, over sessions that are not superseded. */
export function rankConcurrency(
  live: readonly LiveSession[],
  superseded: ReadonlySet<string> = new Set(),
): Map<string, SessionConcurrency> {
  const counted = live.filter((s) => !superseded.has(s.id));
  const device = new Map<string, Concurrency>();
  const account = new Map<string, Concurrency>();
  const rank = (groups: Map<string, LiveSession[]>, into: Map<string, Concurrency>) => {
    for (const group of groups.values()) {
      group.sort(byStart).reverse();
      group.forEach((s, i) => into.set(s.id, { rank: i + 1, concurrent: group.length }));
    }
  };
  rank(
    groupBy(counted, (s) => s.deviceHash),
    device,
  );
  rank(
    groupBy(counted, (s) => s.userId),
    account,
  );
  const out = new Map<string, SessionConcurrency>();
  for (const s of live) {
    const alone = { rank: 1, concurrent: 1 };
    out.set(s.id, {
      device: device.get(s.id) ?? alone,
      account: s.userId === null ? null : (account.get(s.id) ?? alone),
    });
  }
  return out;
}
