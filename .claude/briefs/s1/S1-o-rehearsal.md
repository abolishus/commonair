<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-o rehearsal: prove each launch wave before it opens

You are implementing unit S1-o for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- [ADR 0041](../../../docs/decisions/0041-launch-scale.md) decision 8 and "Maintainer's answers":
  launch opens in waves of 100, 300 and 1,000 concurrent go-lives, with about 10,000 concurrent
  viewers at the last, and the largest single stream planned at 500 viewers.
- [ADR 0032](../../../docs/decisions/0032-scaling-and-availability.md) §1: the availability and
  recovery targets, and the database failover numbers that were measured with a tool that was
  never committed.
- `docs/operators/capacity.md`, with S1-i's cost tables, and `docs/operators/autoscaling.md` and
  `admission.md` from wave 2.
- The merged code of every earlier unit, and the `placement` and `admission` scenarios.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 3**: work in your own git worktree, on branch
`s1/o-rehearsal`, cut from `main` after wave 2 merged. No other launch-scale unit runs beside
you.

## Why

Each launch wave is a go or no-go decision, and the maintainer needs evidence for it: the pools
grew and drained on their own, costs per stream held, nothing was lost when a host or a database
node died, and admission control engaged cleanly at the ceiling. **You build the tooling and the
runbook. You do not run anything on DigitalOcean:** every run there is paid, and the maintainer
approves and starts each one.

The load tooling cannot reach these sizes today:

- every streamer runs on the first generator (`capacity.md:305`), so 1,000 publishing ffmpegs
  need to spread;
- one generator address carries about 430 viewers before the playback rate limit
  (`capacity.md:31-39`), so 10,000 viewers need about 24 addresses;
- streamer accounts sign up at 10 auth writes a minute per address
  (`HARNESS_LOAD_AUTH_PER_MINUTE`), so 1,000 new accounts take hours from one address;
- there is no `failover` scenario.

## You own (write only these)

- `harness/scenarios/scale.ts`, `harness/scenarios/failover.ts` and
  `harness/scenarios/load-launch.ts` (all new).
- `harness/src/load.ts` and `harness/src/load/**` (S1-i's unit is merged; you extend it).
- `harness/src/streamer.ts` and `harness/src/ffmpeg.ts`, only for sharding streamers and a
  cheaper test source.
- `harness/src/shards.ts`, to place the local scenarios.
- `docs/operators/launch-rehearsal.md` (new) and the results sections of
  `docs/operators/capacity.md`.

**Read-only:** every service, package, `infra/**` and `scripts/**`. Anything that needs a
change there is a **contract request**, and so is any finding that a service misbehaves.

## Contracts you must honor

- **The instance under test is an unmodified release** with production settings: no raised rate
  limits, no moderation shortcut, real sign-up for accounts (`capacity.md:44`).
- A generator limit is never reported as the target's. Keep `inconclusive`.
- Test credentials live in the accounts file (`HARNESS_LOAD_ACCOUNTS_FILE`, mode 0600), never in
  git or a report.
- Runs on DigitalOcean use the project and tag ADR 0025's amendment of 2026-11-04 names, and
  everything is destroyed afterwards. The runbook says so at each step.

## Build

1. **Streamers on every generator.** Shard streamers the way HTTP viewers are sharded
   (`assignShardHosts`, `harness/src/load/processes.ts`), with the `LOAD_SHARD` protocol
   reporting each publisher's state. Measure how many test publishers one generator core
   sustains, and offer a low-cost source (a pre-encoded loop sent with stream copy) beside
   `testsrc2`, since encoding 1,000 synthetic streams would make the generators the limit. The
   target must still receive a real stream at the requested size and bitrate.
2. **Accounts at scale.** Pace sign-ups per generator address in parallel, reuse the accounts
   file across runs, and print the expected time before starting. 1,000 accounts from 10
   addresses is about 20 minutes the first time.
3. **Viewers across streams.** A distribution parameter for `load-launch`: a long tail (most
   streams with a few viewers), a middle, and one stream at the largest size (500). Give the
   shape as numbers in the report.
4. **`load-launch`**: one invocation per wave (`--set wave=100|300|1000`), which holds the
   wave's streams and viewers for a set time and judges:
   - the playback targets the sweep already uses (latency, time to first frame, stalls, errors);
   - go-live success: time from publish to live, and refusals (expected: none below the cap);
   - cost per stream and per viewer against S1-i's numbers, per pool;
   - pool sizes over time against what the scaler's rules predict;
   - moderation sample lag and capture failures;
   - Postgres and Valkey CPU, connections against the pooler's limits, and replication lag from
     the provider where it is available.
5. **`scale`**, a local scenario and a remote mode:
   - locally, on the two-media-node harness stack with a test scaler adapter: load rises, a
     node is added, load falls, a node is cordoned, drains and is removed, and no stream is cut;
   - remotely: 100 streams rising to 300 and falling back, with the real adapter. It records
     each host's time from create to accepting streams against the 3-minute target, and checks
     that scale-in never touched a live stream.
6. **`failover`**, the committed version of the tool behind ADR 0032's numbers:
   - a writer that makes an acknowledged write every 100 ms and a Valkey increment, and counts
     failed and lost ones, as the 2026-11-04 measurement did;
   - steps the operator triggers and the scenario times: a database failover, a Valkey
     failover, an app host killed, a media host killed with streams on it, a moderation host
     killed;
   - for the media host: the share of its streams that resumed inside the reconnect grace, and
     viewer stall time;
   - results judged against ADR 0032 §1 and written to the report.
7. **Admission at the ceiling**, in the remote runbook: with the cap set to the wave's size,
   push past it and check that refusals are counted, the alert fires, live streams are
   unaffected, and the dashboard state shows.
8. **`launch-rehearsal.md`**, the runbook the maintainer follows:
   - generators: how many, what size, per wave, from Build 1 and the 430-per-address rule, with
     droplet-hours and a way to read current prices with `doctl`;
   - the order: `scale` remote, then `load-launch` per wave, then `failover` at that load, then
     the admission check;
   - **a go/no-go table per wave** with a threshold for every judged number, and what to do on
     each failure;
   - teardown, and a check that nothing tagged for the run is left.
9. **Results.** `capacity.md` gains a "Launch rehearsals" section: one row per run with the
   wave, the release, the pools' sizes, the verdict and what broke first.

## Edge cases

- A generator dying mid-run: the run is inconclusive, and its streams are reported as the
  generator's loss, not the target's.
- Publishers that reconnect on their own during a host kill, and ones that do not.
- A wave that is refused entry because the cap is lower than `wave`: say so before starting.
- Accounts from an earlier run that no longer exist on a fresh instance.
- A run interrupted by the operator: generators stop publishing and viewers stop within seconds,
  and the report still writes.
- Clock differences between generators when timing a failover.

## Tests you must add

- Unit tests: streamer sharding, the viewer distribution, the wave judge with each threshold at
  its boundary, the failover writer's lost-write accounting, the go/no-go evaluation.
- The local `scale` scenario and a tiny local `load-launch` (a few streams) run in the harness;
  place them in `harness/src/shards.ts`.
- A local `failover` run against the compose stack that kills a second app instance and a
  second media node, in the style of `multi-instance`.
- `load-smoke` and S1-i's scenarios still pass unchanged.

## Reviewer focus

- Nothing weakens the instance under test.
- Generator limits and target limits cannot be confused, at any wave.
- The failover accounting counts acknowledged-then-lost writes correctly.
- Every paid step in the runbook has a cost estimate, an owner (the maintainer) and a teardown.
- The go/no-go table has a threshold for everything ADR 0041 gates a wave on.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun --bun vp test run harness`, `bunx tsc -p harness
--noEmit`, lint, format and `reuse lint`. `git status` shows only your paths. Commit with `git
commit -s`.

Your final message lists: what you built, test counts, how many publishers and viewers one
generator carried locally, the generator plan and droplet-hours per wave, contract requests and
service findings, and the exact commands for each paid run in order.
