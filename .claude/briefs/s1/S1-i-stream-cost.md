<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-i stream cost: what one stream and one viewer cost, each measured alone

You are implementing unit S1-i for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- [ADR 0041](../../../docs/decisions/0041-launch-scale.md), decision 5 (the cost targets this
  unit measures against) and decision 8.
- `docs/operators/capacity.md`, all of it: the runbook, the `c-4` result and the tooling's
  limits.
- `.claude/briefs/s1/S1-a-capacity.md`, the unit that built `load-plan` and `load-sweep`.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 0**: work in your own git worktree, on branch
`s1/i-stream-cost`, cut from `main`. No other launch-scale unit runs beside you.

## Why

The launch target is 1,000 concurrent live streams and about 10,000 viewers. Every pool size and
the budget wait for four numbers, and today's come from one sweep that never measured them
apart (`capacity.md`, `c-4`, 2026-11-04):

| Cost                                | Known today            | ADR 0041 target |
| ----------------------------------- | ---------------------- | --------------- |
| Ingest + HLS packaging, no ladder   | never measured alone   | ≤ 0.1 core      |
| Moderation, per live stream         | about 0.2–0.25 core    | ≤ 0.05 core     |
| Caddy + origin, per 100 HLS viewers | about 0.5 core         | ≤ 0.15 core     |
| One 1080p ladder                    | about 2.1 cores on CPU | CPU vs NVENC    |

You build the tooling that isolates each cost and says where the CPU goes. **You do not run it on
DigitalOcean.** That run is paid and the maintainer approves and starts it; your final message
gives the exact commands.

## You own (write only these)

- `harness/scenarios/load-plan.ts`, `load-sweep.ts`, `load-smoke.ts`, and a new
  `harness/scenarios/load-cost.ts`.
- `harness/src/load.ts` and `harness/src/load/**`.
- `harness/src/http-viewer.ts` and the `openViewers` function in `harness/src/platform.ts`
  (`:187-217`), only to pass the viewer options through.
- `infra/containers/entrypoint.sh`, only for the profiling switch in Build 3.
- `docs/operators/capacity.md`.
- Tests beside the files above.

**Read-only:** every service, `packages/**`, `compose.yaml`, `scripts/**`. Anything else is a
**contract request**.

## Contracts you must honor

- **The instance under test is an unmodified release.** `capacity.md:44` forbids raising rate
  limits. There is no moderation off switch and you must not add one
  (`packages/config/src/env.ts:309-311`: "Nothing here can switch the pipeline off"). Isolate
  costs by subtraction and by per-container samples, never by disabling a safety pipeline.
- The existing `--set` keys keep their meaning (`LOAD_PARAM_KEYS` in `harness/src/load/params.ts:11`,
  `SWEEP_PARAM_KEYS` in `harness/src/load/sweep.ts:102`), and existing reports keep their fields.
- A generator limit is never reported as the target's: keep the `inconclusive` rules.

## Build

1. **`load-cost`, a new scenario** that runs fixed cells and reports cores per unit, not a
   pass/fail sweep. Each cell holds for `seconds` (default 180) after a warm-up, and samples
   per-container CPU through the existing `CpuSampler` (`remotePodmanStats`,
   `harness/src/load/ssh.ts:76`) and the host through `HostSampler`.

   | Cell           | Streams        | Viewers                                   | Yields                                              |
   | -------------- | -------------- | ----------------------------------------- | --------------------------------------------------- |
   | `idle`         | 0              | 0                                         | the baseline to subtract                            |
   | `ingest`       | N (default 10) | 0                                         | mediamtx + media + worker + valkey cores per stream |
   | `ingest-2x`    | 2N             | 0                                         | whether the per-stream cost is linear               |
   | `viewers`      | 1              | V below the ladder threshold (default 40) | caddy + origin + api cores per viewer               |
   | `viewers-many` | S (default 10) | V each, below the threshold               | the same across many paths (cache misses)           |
   | `ladder`       | 1 at 1080p     | just over the threshold                   | cores per ladder, by subtraction from `viewers`     |
   - Zero viewers must be a legal cell: today `judgeLoad` asserts every viewer started, and the
     sweep's `planSteps` requires steps ≥ 1.
   - Attribute cores to containers: `mediamtx`, `media`, `worker`, `origin`, `caddy`, `api`,
     `postgres`, `valkey`. Moderation spans two: the capture in `media`
     (`services/media/src/moderation/sampler.ts`) and the classifier in `worker`
     (`services/worker/src/jobs/moderation-scan.ts`). Report both, and their sum as "moderation
     per stream" using the `ingest` cells.
   - Report Valkey's network bytes per stream too: each sample puts a 384² RGB frame in Valkey
     (`moderation:frame:<id>`, about 440 kB).

2. **Viewer knobs.** `HttpViewerOptions.heartbeats` and `fetchSegments`
   (`harness/src/http-viewer.ts:37-41`) exist but `openViewers` does not pass them. Add `--set
   heartbeats=false` and `--set fetchSegments=false` to `load-cost` only, so the `viewers` cell
   can split segment serving from playback API calls. A run without heartbeats ends inside the
   playback token's 120 s life: cap `seconds` and say so in the report.
3. **CPU profiles.** No service has profiling support today.
   - `entrypoint.sh` starts the service with Bun's CPU profiler when `COMMONAIR_CPU_PROFILE` names
     a directory. Unset, the command line is byte-identical to today's.
   - Check first that the pinned Bun's `--cpu-prof` writes a profile on SIGTERM for a long-running
     server. If it does not, say so in your final message and fall back to `perf` on the target
     host from the runbook, with no entrypoint change.
   - The switch is for the test instance only. Document it in `capacity.md`, not in the
     self-hosting docs.
   - `load-cost` collects the profiles over the existing SSH channel into the report directory.
   - ffmpeg and MediaMTX are not Bun: for those the runbook uses `perf top`/`perf record` by
     container PID. Write the commands in `capacity.md`.
4. **GPU cell.** `capacity.md` gains a runbook section for the `ladder` cell on a GPU droplet
   with `TRANSCODE_HWACCEL=nvenc`: how to confirm NVENC is in use, ladders per GPU
   (`defaultTranscodeSlots` gives 2), and cost per ladder-hour beside the CPU figure. Prices are
   read at run time with `doctl`, not written into the doc.
5. **`capacity.md`.**
   - A "Cost per stream and per viewer" table with one row per size and release: the four costs
     above, each with its container breakdown, and the linearity check.
   - A worked sizing formula for a pool from those numbers, with ADR 0041's 60% scale-out
     threshold.
   - The 430-viewers-per-generator-address limit restated for `viewers-many`.

## Edge cases

- A cell whose generator was the limit is `inconclusive`, as in the sweep.
- Subtraction can go negative from noise: report the raw cell numbers and the difference, and
  flag any difference smaller than the idle cell's own p95 spread.
- `podman stats` samples every 5 s: a cell shorter than 60 s after warm-up is refused.
- A stream that never became live makes its cell fail, not silently measure nothing.
- Against the local stack the numbers are the developer machine's. Print that warning, as the
  sweep does.

## Tests you must add

- Unit tests for the cell planner, the subtraction and attribution maths (including the
  negative and noisy cases), the zero-viewer path, and the report shape.
- `load-smoke` still passes unchanged. Add a `load-cost` smoke variant with tiny cells (2
  streams, 5 viewers, 20 s with the minimum check relaxed by a test-only parameter) that the
  local stack can run, and say whether it should join a harness shard (`harness/src/shards.ts`),
  as a contract request.
- A test that `entrypoint.sh` produces the same command with the profiling variable unset.

## Reviewer focus

- Nothing weakens the instance under test: no rate-limit override, no moderation switch.
- Costs are attributed to the right container, and moderation counts both halves.
- Inconclusive stays inconclusive.
- The profiling switch cannot be on by accident in production.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun --bun vp test run harness`, `bunx tsc -p harness
--noEmit`, `shellcheck infra/containers/entrypoint.sh`, lint, format and `reuse lint` on your
files. `git status` shows only your paths. Commit with `git commit -s`.

Your final message lists: what you built and test counts; the exact commands for the paid run
(droplets to create, one `load-cost` invocation per cell set, the profile collection, the GPU
cell, teardown) with an estimate of droplet-hours; whether Bun's profiler worked; and any
contract requests.
