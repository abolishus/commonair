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
  // N1's notifications (~3 min) leaves the most room under the ~12 min cap, so W2's DVR and
  // rehearsal scenarios join it (batch 6). Re-measure once their steps land; split if it passes 12.
  notify: ["notifications", "live-dvr", "rehearsal"],
  // W2 (batch 6 decision (c)): the whisper sidecar and its weights, path-filtered on pushes
  // (`PATH_FILTERED_SHARDS`) and always on the nightly run.
  captions: ["captions"],
  rest: null,
} as const satisfies Record<string, readonly string[] | null>;
export type FullShard = keyof typeof FULL_SHARDS;

/**
 * Shards a push to main runs only when its changes reach the paths named here (repository-relative
 * regular expression sources; tests and docs never count). A narrowed harness selection that
 * includes one of the shard's scenarios runs it too. The nightly run and a dispatch run every
 * shard. scripts/ci-changes.ts applies this.
 */
export const PATH_FILTERED_SHARDS: Readonly<Partial<Record<FullShard, readonly string[]>>> = {
  captions: [
    // Captions code wherever it lives (packages/captions, services/*/src/captions, the player, the harness).
    "(^|/)(w2-)?captions(/|\\.|-|$)",
    "^services/media/",
    "^services/origin/",
    "^packages/chat-filter/",
    "^infra/containers/whisper",
    "^scripts/fetch-model\\.ts$",
    "^harness/compose\\.w2-captions\\.yaml$",
    "^compose\\.yaml$",
  ],
};
