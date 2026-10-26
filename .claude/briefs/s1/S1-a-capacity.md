<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-a: capacity numbers on dedicated DigitalOcean droplets

You are implementing unit S1-a for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/S1-scaling.md` (the milestone
this unit opens) and [ADR 0025](../../../docs/decisions/0025-hosting-on-digitalocean.md). Do not
look outside the repository. Work in your own git worktree on a branch named `s1/a-capacity`.

## Why

Production starts as one dedicated-vCPU droplet (ADR 0025), and its size is a placeholder.
Every S1 stage trigger ("Postgres CPU over 50%", "concurrent live streams past the per-host
number") needs measured numbers, and L1 cannot pick a launch size without them. `load-plan`
(E6, ADR 0021) measures the right things, but only against a stack on the harness's own machine.
This unit makes the load harness measure a **remote** instance installed with `selfhost.sh`, adds
a sweep that finds where one host stops coping, and writes the runbook and the results page.
The live runs on droplets are the user's (or the orchestrator's with the user's token); you build
and test the tooling.

## You own (write only these)

- `harness/src/load.ts`, `harness/src/load/**` (new files there are fine)
- `harness/src/metrics.ts`: **additive changes only** (new samplers, new exports). Other
  scenarios import `CpuSampler`, `podmanStats` and the metric helpers; their behavior and
  signatures must not change.
- `harness/scenarios/load-plan.ts`, new `harness/scenarios/load-sweep.ts`
- `harness/tests/load-*.test.ts` (new), `harness/tests/load-plan.test.ts`
- `harness/README.md`: only the "Metrics and the load test" section, the `load-plan` section and
  one new `load-sweep` row and section
- `docs/operators/capacity.md` (new)
- `scripts/load/**` (new, optional: helper scripts for the droplet runbook)

## Contracts you must honor (read-only for you)

- `harness/src/env.ts`: the `HARNESS_*` schema. New variables are a **contract request** (exact
  names, types, defaults, doc comments); until the orchestrator adds them, read them through a
  small parser in `harness/src/load/` with the same names, so the change is a move later.
- `harness/src/scenario.ts` (`defineScenario`, `ScenarioContext`), `harness/src/users.ts`,
  `harness/src/viewer.ts`, the platform helpers: use, do not change.
- The instance under test is an unmodified release: `selfhost.sh install` from a signed bundle,
  configured only through `~/.config/commonair/commonair.env`. No test-only code paths in
  services; no weakened defaults in `infra/**` or `scripts/selfhost.sh`.
- Security defaults stay: Caddy has no `trusted_proxies` (`infra/caddy/`), and a spoofed
  `X-Forwarded-For` is ignored (proved on the rc droplet). Do not change that to make load clients
  look distinct.

## What is missing today (verified at `1c2778f`)

1. **CPU comes from the local Podman.** `runLoad` uses `CpuSampler` with `podmanStats`
   (`harness/src/metrics.ts:148`), which runs `podman stats` on the harness machine. Prometheus
   (`infra/prometheus/prometheus.yml`) scrapes no container or host CPU.
2. **Nothing measures the host**: whole-droplet CPU, memory, load and NIC transmit bytes, which
   are what the S1 triggers and DigitalOcean's metered egress are about.
3. **Sign-ups need Mailpit and distinct addresses.** `signUp` verifies through Mailpit
   (`harness/src/users.ts:127`). A real install sends real mail, and its `auth` rate-limit bucket
   (`services/api/src/lib/ratelimit.ts`) allows about 10 sign-ups per client address, which 20
   streamers from one generator exceed.
4. **One generator machine.** HTTP viewers shard over child processes on the same host
   (`harness/src/load/shard.ts`). PLAN size (20 × 200 at about 1.2 Mbit/s each) is several Gbit/s;
   one droplet may run out of CPU or NIC before the target does, and the result then measures the
   generator.
5. **No sweep.** `load-plan` runs one fixed size and passes or fails; capacity needs the largest
   size that still meets the targets.

## Build

### 1. Remote target sampling

- A sampler that runs `podman stats --no-stream --format json` on the target over SSH
  (`ssh -o BatchMode=yes <target> …` as the `commonair` user, which owns the rootless
  containers) and reuses `parsePodmanStats`. Selected when the target SSH destination is set;
  local `podmanStats` stays the default, so `load-smoke` and the harness stack are unchanged.
- A host sampler over the same SSH connection: `/proc/stat` (CPU busy % across all cores),
  `/proc/meminfo`, `/proc/loadavg` and `/proc/net/dev` (tx and rx bytes per interface, so
  public and VPC traffic are separate). Sample every 5 s, like `CpuSampler`. Pure parsers with
  unit tests; the SSH call is the only side effect.
- The same host sampler on the generator itself (read locally), reported next to the target's.
- Report both in the load report as `target.host`, `target.containers`, `generator.host`, and as
  metrics (`target.cpu.mean`, `target.cpu.p95`, `target.nic.tx_bytes_per_second`, …).
- An SSH failure mid-run marks the samples incomplete; it never fails the scenario on its own.

### 2. A test instance the harness can drive

Document, in `capacity.md`, a test-instance configuration that uses only the env file:

- **Mail**: point `SMTP_*` at a Mailpit the generator runs (on the VPC address; Mailpit image
  pinned like the harness stack's), and set `HARNESS_MAILPIT_URL` to it. No code change.
- **Sign-up addresses**: pick the least invasive way to create 20–100 streamer accounts on a
  real instance without weakening defaults, and justify it in your final message. Options to
  weigh: sign-ups paced under the limit (`auth` is 10 per minute per address,
  `services/api/src/lib/ratelimit.ts:21`, so 100 accounts take about 10 minutes, once per
  instance if the accounts are reused across steps and sizes); accounts created ahead of time
  (the role CLI in install.md §5 only changes roles, so this needs a new path); an env override
  of the `auth` bucket (none exists: `DEFAULT_RATE_LIMITS` is a constant). Anything that needs
  a new API env var or command is a contract request, not a change you make.
- **Viewers do not sign up**: confirm the HLS and playback-session path needs no account and no
  auth-bucket hit per viewer; if it does, say so with the code path.

### 3. Generator capacity

- A judge that marks a run **inconclusive** (not failed, not passed) when the generator's CPU
  p95 is over 80% or its NIC transmit/receive is within 15% of the measured ceiling, so a
  generator limit is never reported as the target's.
- Remote shards: `ShardProcess` can start `harness/src/load/worker.ts` on other generator hosts
  over SSH (same repo checkout path, same line protocol on stdout), selected by a host list.
  Each host gets the shard specs round-robin. Local child processes stay the default. Build this
  only after the local version of the judge exists, and keep it behind the host list.

### 4. `load-sweep` scenario

- Steps the audience up (for example 250, 500, 1000, 2000, 4000 viewers across
  `streamers` channels; `--set steps=…`), holding each step `seconds` long after viewers are
  started, with a cool-down between steps. Streamers stay up across steps.
- A second axis: `--set streamerSteps=…` steps live streams at a fixed small audience, to find
  the transcode limit (ladders start at `TRANSCODE_VIEWER_THRESHOLD`, default 50; say in the
  report how many streams had ladders).
- Stops at the first step that breaks a target: p95 glass-to-glass latency, TTFF, stall ratio,
  error rate (reuse `judgeLoad`'s thresholds as defaults, overridable with `--set`), target CPU
  p95 over 85%, or target NIC at its ceiling. Records which one broke.
- Output: one row per step in the report (`sweep` section) and a summary: the last passing step,
  the first failing step and why, and per-viewer egress and CPU at the last passing step.
- `inFull: false`, like `load-plan`.

### 5. Runbook and results: `docs/operators/capacity.md`

- How to stand up the run with `doctl` (or the DigitalOcean MCP server), per ADR 0025
  decision 5 (the operator's scoped token; never in git or in an agent's context):
  - one target droplet per size under test, from the Debian 13 image, in one region and one VPC;
    sizes are dedicated-vCPU General Purpose and CPU-Optimized. List the current slugs with
    `doctl compute size list` at run time instead of hard-coding them, and record the slugs used;
  - one or more generator droplets in the same VPC (CPU-Optimized is a sensible start);
  - the release installed on the target with `selfhost.sh install` and the test-instance env from
    part 2; the generator resolving the instance's domain to the target's **VPC address**
    (`/etc/hosts`), so viewer traffic stays on the private network. Check DigitalOcean's current
    billing docs on whether VPC traffic counts toward transfer and write down what they say,
    with the date.
  - tear-down commands, so nothing is left running (droplets bill per second).
- A results table to fill in per size: max concurrent viewers and live streams within targets,
  what broke first, per-viewer origin egress, target CPU and NIC at the last passing step,
  Postgres and Valkey container CPU, release version, date. Leave it empty with one example row
  marked as an example.
- How the numbers map to S1's triggers and to L1's launch size.

## Tests you must add

- Unit tests for every parser and pure function: `/proc/stat` deltas (including counter wrap
  and a CPU going offline), `/proc/meminfo`, `/proc/loadavg`, `/proc/net/dev` (several
  interfaces, IPv6-only, zero traffic), the inconclusive judge (each threshold, exactly at the
  boundary), sweep step planning (empty steps, one step, non-increasing steps rejected), the
  stop rule (first breaking metric wins; ties reported together), remote shard assignment.
- The SSH samplers tested with an injected runner (no real SSH in unit tests), including a
  runner that fails halfway.
- `load-plan.test.ts` keeps passing unchanged in behavior for the local path.
- No integration test needs a droplet. If you can, run `load-smoke` against the harness stack to
  show the local path still works; if the stack is not up, say so instead.

## Done means

- Targeted checks only (`.claude/briefs/_done-means.md`): `bun --bun vp test run harness/tests`
  scoped to your files, `vp lint --deny-warnings` and `vp fmt` on your paths, the harness
  typecheck. The user runs the gate and the droplet runs.
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits), message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Final message: what you built, test counts, branch and commit sha, **contract requests**
  (exact changes, e.g. the `HARNESS_*` variables for `harness/src/env.ts`), your sign-up-address
  choice and why, anything left undone, and the exact commands to run the sweep on droplets
  (from creating them to tearing them down).
