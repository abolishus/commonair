// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// No imports: scripts/ (the gate, CI's tests) read the shard list without the harness's types.

/**
 * Parts of `full` for parallel runners (clock-skew ~20 min holds a broadcast through a ladder
 * restart; the others as measured below). `rest` is everything the named shards leave, so a new
 * scenario is always in some shard. Each shard runs in `full`'s order.
 *
 * Scenario time per shard on the full run of 8a562d9a (2026-11-01, run 41309310706): relay 8m09s,
 * long 7m42s (trust-safety 4m36, e5-coop 3m06), interact 11m29s, notify 7m48s, rest 16m20s.
 * `rest` is over the batch 7 README's ~12 min cap: split it once its per-scenario times are
 * measured (open follow-up, recorded for the orchestrator).
 */
export const FULL_SHARDS = {
  relay: ["e2e-relay"],
  long: ["trust-safety", "e5-coop"],
  clock: ["clock-skew"],
  interact: ["interact", "channel-bot"],
  // W1 (batch 4): ~15 min with both, so N1's notifications runs apart (decision (m), ~12 min cap).
  features: ["timeline-sync", "surge-guard"],
  // Batch 6 joined W2's DVR and rehearsal scenarios to N1's notifications. Measured on the full
  // run of 8a562d9a (2026-11-01, run 41309310706): 7m48s (live-dvr 4m08, notifications 2m47,
  // rehearsal 53s), under the ~12 min cap, so nothing moved. B7-followups' rehearsal step is short.
  notify: ["notifications", "live-dvr", "rehearsal"],
  // W2 (batch 6 decision (c)): the whisper sidecar and its weights, path-filtered on pushes
  // (`PATH_FILTERED_SHARDS`) and always on the nightly run.
  captions: ["captions"],
  // Batch 7 decision (d): W3's watch rooms and portability, N3's Twitch import and N4's
  // federation, on the stack with the batch 7 overrides (scripts/verify.ts `w3Stack`). Not
  // path-filtered. Re-measure after wave 2, as `interact` (11m29s on the same run: channel-bot
  // 7m28, interact 4m00), which gains the giveaway, surge-raid and fair-prediction steps.
  w3: ["watch-room", "portability", "twitch-import", "federation"],
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
