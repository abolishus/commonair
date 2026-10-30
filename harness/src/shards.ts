// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// No imports: scripts/ (the gate, CI's tests) read the shard list without the harness's types.

/**
 * Parts of `full` for parallel runners (e2e-relay ~9 min; trust-safety ~6.5 and e5-coop ~3;
 * clock-skew ~20, it holds a broadcast through a ladder restart; the rest ~9.5). `rest` is everything the named shards leave,
 * so a new scenario is always in some shard. Each shard runs in `full`'s order.
 */
export const FULL_SHARDS = {
  relay: ["e2e-relay"],
  long: ["trust-safety", "e5-coop"],
  clock: ["clock-skew"],
  interact: ["interact", "channel-bot"],
  // W1 (batch 4): ~15 min with both, so N1's notifications runs apart (decision (m), ~12 min cap).
  features: ["timeline-sync", "surge-guard"],
  notify: ["notifications"],
  rest: null,
} as const satisfies Record<string, readonly string[] | null>;
export type FullShard = keyof typeof FULL_SHARDS;
