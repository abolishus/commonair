// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// No imports: scripts/ (the gate, CI's tests) read the shard list without the harness's types.

/**
 * Parts of `full` for parallel runners, each under the ~12 min cap (batch 8 decision (o): a single
 * scenario over it is split or trimmed, never left as an exception). `rest` is everything the named
 * shards leave, so a new scenario is always in some shard. Each shard runs in `full`'s order.
 *
 * Scenario time per shard (harness PASS lines, scenarios summed) on the push run of b8ff94df
 * (2026-11-04, run 41894534066, every shard but the path-filtered two), with the run of c30aa706
 * (41883112744) in brackets where it differs by more than a minute: clock 10m36s (clock-skew),
 * surge 9m25s, w3 9m23s (watch-room 6m33, federation 2m08, portability 26s, twitch-import 16s),
 * relay 9m19s [8m07s], features 9m19s (timeline-sync 4m41, e5-coop 4m38), interact 8m54s
 * [10m40s], rest 8m45s, core 8m15s (integrity-basic 3m02, viewers 1m55, e4b-money 1m46,
 * multi-instance 1m32), notify 8m04s (live-dvr 4m11, notifications 2m55, rehearsal 58s),
 * relay-dvr 7m45s [6m27s], long 7m31s, bot 7m16s. The path-filtered shards on the push run of
 * b5f2bebf (41827726573): captions 3m45s, and seed 15m33s (12m19s on 656f658a, run
 * 41816121331; 16m30s on the nightly of eeff9ecb, 42215129857).
 *
 * seed is one scenario, and most of it is the seed: `seed full --scale small` took 10m06s and
 * 9m34s on those two runs (media 3m55, coop 2m40, safety 1m40, mostly waiting on recordings,
 * proposal periods and suspensions), the crawl 5m27s and 6m56s. The crawl was the logins one by
 * one, each waiting under its own user's API rate limit (about 4.5 min of the nightly's crawl was
 * those waits). Splitting the crawl into two shards would run the 10 min seed twice, each shard
 * still about 12 min, so instead the crawl runs three logins side by side (`CRAWL_CONCURRENCY`,
 * harness/src/seed/visit.ts), every route still as its role: an estimate, until CI measures it,
 * of about 2.5 min (viewer1's).
 *
 * The seed itself was 9m34s on the nightly of eeff9ecb (social 12 s, interact 37, money 17, media
 * 234, safety 99, coop 160, platform 15), mostly waits. Cut since, estimates until CI measures
 * them (the scenario records each unit's time, `seed-coverage.seed.<unit>`): media records five at
 * a time without batch barriers (its four batches were 199 s, now about 110: media ~145 s);
 * safety's cell suspensions last 20 s, not 60 (its lapse wait was 57 s: safety ~60 s); coop runs
 * on the seed stack's shorter governance periods (compose.seed.yaml; its restorations were 150 s,
 * now about 100: coop ~110 s); and money runs beside media (harness/src/seed/units.ts `runUnits`).
 * Measured on the push run of d16972e4 (42286121862): seed-coverage 10m20s, the seed 7m03s (social 14 s,
 * interact 36, money 21, media 2m37, safety 1m04, coop 1m53, platform 38) and the crawl 3m14s.
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
