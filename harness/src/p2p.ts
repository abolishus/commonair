// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P2P in the `viewers` scenario (P1, ADR 0005 amendment 1): parameters and the pure checks on
 * what the database recorded. Opted-in viewers are web Chromium players whose storage chose P2P;
 * default viewers have no storage keys and get the operator default, which the stack keeps `off`.
 */

/** `p2p` until P1-player merges: 0 keeps the scenario as it was. Then 10. */
export const P2P_VIEWERS_DEFAULT = 0;
/** Opted-in sessions' HTTP bytes per watched second must be at least this much below the baseline. */
export const P2P_EGRESS_MARGIN = 0.2;
/** Integrity's fetch checks (packages/integrity/src/signals/fetch.ts); none may hit an honest P2P viewer. */
export const FETCH_REASONS = [
  "no_media_fetched",
  "too_few_segments",
  "too_many_segments",
  "playlists_without_segments",
  "segments_without_playlists",
] as const;

export interface P2PViewerParams {
  /** Opted-in web Chromium viewers. */
  optedIn: number;
  /** Web Chromium viewers left at the default (off). */
  atDefault: number;
}

/** `--set p2p=<n> --set p2pDefault=<n>`: `p2pDefault` defaults to 1 when `p2p > 0`, else 0. */
export function p2pViewerParams(intParam: (name: string, fallback: number) => number): P2PViewerParams {
  const optedIn = Math.max(0, intParam("p2p", P2P_VIEWERS_DEFAULT));
  const atDefault = Math.max(0, intParam("p2pDefault", optedIn > 0 ? 1 : 0));
  return { optedIn, atDefault };
}

export interface SessionStats {
  id: string;
  bytes_http: number;
  bytes_p2p: number;
  watch_seconds: number;
  verdict: string;
  verdict_reasons: string[] | null;
}

/** Total HTTP bytes per total watched second over sessions; null when nothing was watched. */
export function httpBytesPerSecond(rows: readonly SessionStats[]): number | null {
  const seconds = rows.reduce((s, r) => s + Number(r.watch_seconds), 0);
  if (seconds <= 0) return null;
  return rows.reduce((s, r) => s + Number(r.bytes_http), 0) / seconds;
}

/** Whether opted-in sessions fetched at least `margin` less over HTTP than the baseline did. */
export function egressDropped(optedIn: number | null, baseline: number | null, margin = P2P_EGRESS_MARGIN): boolean {
  if (optedIn === null || baseline === null || baseline <= 0) return false;
  return optedIn <= baseline * (1 - margin);
}

/** Sessions whose verdict is not `verified` or that carry an integrity fetch reason. */
export function unverified(rows: readonly SessionStats[]): SessionStats[] {
  return rows.filter(
    (r) =>
      r.verdict !== "verified" ||
      (r.verdict_reasons ?? []).some((reason) => (FETCH_REASONS as readonly string[]).includes(reason)),
  );
}
