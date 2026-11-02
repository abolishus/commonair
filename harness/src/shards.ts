// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// No imports: scripts/ (the gate, CI's tests) read the shard list without the harness's types.

/**
 * Parts of `full` for parallel runners, each under the batch 7 README's ~12 min cap where one
 * scenario allows it. `rest` is everything the named shards leave, so a new scenario is always in
 * some shard. Each shard runs in `full`'s order.
 *
 * Scenario time per shard on the push run of fc1fc4ff (2026-11-01, run 41357496846, batch 7 wave
 * 2), before this split: interact 16m07s (interact 8m50, channel-bot 7m17), rest 15m46s,
 * features 14m49s (surge-guard 9m58, timeline-sync 4m51), relay 13m60s, clock 12m49s, long
 * 12m44s (trust-safety 8m17, e5-coop 4m27), notify 8m04s, captions 3m46s. `relay` (e2e-relay) and
 * `clock` (clock-skew holds a broadcast through a ladder restart) are single scenarios.
 */
export const FULL_SHARDS = {
  relay: ["e2e-relay"],
  long: ["trust-safety"],
  clock: ["clock-skew"],
  // E8, with W3's giveaway, surge-raid and fair-prediction steps (batch 7 decision (d)).
  interact: ["interact"],
  bot: ["channel-bot"],
  // W1 (batch 4) ran timeline-sync and surge-guard together; at ~15 min they run apart, and
  // e5-coop (with W3's jury step) joins timeline-sync.
  features: ["timeline-sync", "e5-coop"],
  surge: ["surge-guard"],
  // Batch 6 joined W2's DVR and rehearsal scenarios to N1's notifications: 8m04s on fc1fc4ff
  // (live-dvr 4m11, notifications 2m55, rehearsal 58s).
  notify: ["notifications", "live-dvr", "rehearsal"],
  // W2 (batch 6 decision (c)): the whisper sidecar and its weights, path-filtered on pushes
  // (`PATH_FILTERED_SHARDS`) and always on the nightly run.
  captions: ["captions"],
  // Batch 7 decision (d): W3's watch rooms and portability, N3's Twitch import and N4's
  // federation, on the stack with the batch 7 overrides (scripts/verify.ts `w3Stack`). Not
  // path-filtered.
  w3: ["watch-room", "portability", "twitch-import", "federation"],
  // The longest of `rest` (8a562d9a: integrity-basic 2m52, viewers 2m04, e4b-money 1m34,
  // multi-instance 1m28), so `rest` drops from ~16 min to ~8.
  core: ["integrity-basic", "viewers", "e4b-money", "multi-instance"],
  // seed-full milestone wiring: `seed full --scale small` on a fresh stack with every override
  // (`stack --seed`), then every web route as its role (docs/testing/seeding.md). It needs a
  // database with no users, so it runs alone; path-filtered on pushes, always on the nightly run.
  seed: ["seed-coverage"],
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
  // What the seed writes and what the coverage scenario visits: the seed itself, the schema,
  // the web routes and the overrides the seed stack layers.
  seed: [
    "^harness/src/seed/",
    "^harness/scenarios/seed-coverage\\.ts$",
    "^harness/compose\\.seed\\.yaml$",
    "^packages/db/src/schema/",
    "^packages/db/drizzle/",
    "^apps/web/src/routes/",
    "^compose\\.yaml$",
  ],
};
