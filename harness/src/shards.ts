// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// No imports: scripts/ (the gate, CI's tests) read the shard list without the harness's types.

/**
 * Parts of `full` for parallel runners, each under the ~12 min cap (batch 8 decision (o): a single
 * scenario over it is split or trimmed, never left as an exception). `rest` is everything the named
 * shards leave, so a new scenario is always in some shard. Each shard runs in `full`'s order.
 *
 * Scenario time per shard on the push run of c389b4e7 (2026-11-03, run 41736761538, batch 8
 * wave 1 merged; harness PASS lines): relay 15m01s (e2e-relay; its W3 DVR steps 5m51s), clock
 * 13m11s, interact 11m27s (B8's three steps 2m15s), surge 9m46s, features 9m18s (e5-coop 4m60,
 * timeline-sync 4m18), w3 8m59s (watch-room 6m01, federation 2m11, portability 27s,
 * twitch-import 20s), rest 8m27s, long 8m24s, core 8m16s, notify 7m58s, bot 7m30s, captions
 * 3m48s. B8-harness then split e2e-relay (relay ~9m10s; relay-dvr ~6m35s plus B8-player's
 * relay-dvr-switch, ~8m15s estimated) and trimmed clock-skew's fixed measurement sleeps to
 * coverage waits (~11m10s estimated: RTMP −1m54s, WHIP −7s). Wave 2 adds M1-coop-money's two
 * e5-coop steps to `features` (~11 min estimated) and B8-player's edge-sync to `w3` (~10 min).
 * The estimates (relay, relay-dvr, clock, features, w3) are replaced by the PASS lines of the
 * first push run after merge; `seed` (seed-coverage) is not timed here (GitHub's API was down).
 */
export const FULL_SHARDS = {
  relay: ["e2e-relay"],
  // B8-harness (batch 8 decision (o)): the relay's DVR, purge feed, `.vtt` and the mid-DVR switch,
  // split out of e2e-relay, which was 15m01s with them.
  "relay-dvr": ["relay-dvr"],
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
