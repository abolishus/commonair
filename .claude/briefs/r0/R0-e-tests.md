<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# R0-e: self-host test gaps and the e2e wiring for R0-a, R0-b and R0-c

You are implementing unit R0-e for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/R0-release.md`,
`.claude/briefs/r0/README.md` and the header of `scripts/selfhost/e2e.ts` (:4-46). Do not look
outside the repository. **Wave 2:** start your worktree from the commit that has R0-a and R0-b
merged (the orchestrator names it, and tells you whether R0-c's `e2e-backup.ts` has landed), on a
branch named `r0/e-tests`.

## Why

Three gaps from PROGRESS.md "Still open" (:451-465) and the R0 plan, plus the checks R0-a, R0-b
and R0-c wrote in their own files so that only one unit edits `e2e.ts`:

- Nothing tests that Quadlet appends its own `ExecStopPost=` **after** the unit's cgroup reset
  (checked by hand on Podman 5.4.2 and 5.8.2). If a Podman release reorders them, the "Device or
  resource busy" restart failure (`ffb3bc7`) comes back silently.
- `infra/tests/stack.int.test.ts` "re-running migrate keeps the role working (idempotent)" (:248)
  has a 60 s limit (:254) and took 76 s once at load 12 on a workstation.
- Local e2e runs pull third-party images from Docker Hub on every fresh host and hit the
  anonymous rate limit once; a pull-through mirror fixes it.

## You own (write only these)

- `scripts/selfhost/e2e.ts`
- `infra/tests/stack.int.test.ts`
- `infra/tests/quadlet-order.test.ts` (new) and any new `infra/tests/*` file you create
- `scripts/selfhost/e2e-mirror.ts` (new, if the mirror logic is more than a few lines)
- `.github/workflows/ci.yml`: **only** the `selfhost-e2e` job (:248-…), and only if a new e2e
  variant needs a matrix entry. Actions stay pinned to commit SHAs (non-negotiable 7).

Read-only: `scripts/selfhost/e2e-irc.ts` (R0-a), `e2e-s3.ts` (R0-b), `e2e-backup.ts` (R0-c),
`infra/quadlet/**`, `scripts/selfhost.sh`. A bug in their check functions is a report to the
orchestrator with the exact fix, not an edit.

## What is there today (verified at `8bbdb52`)

- `quadlet.test.ts:102-111` checks only the source `.container` files: every `RestartMode=direct`
  unit has exactly `ExecStopPost=-/bin/sh %h/commonair/scripts/selfhost/cgroup-reset.sh`. The
  comment at :106 says Quadlet appends its own after ours; nothing runs the generator.
  `cgroup-reset.sh:5-27` explains why it must be last.
- `e2e.ts`: `main()` (:876-980) runs `step(name, fn)` (:128) phases: build images, Zot, release v1,
  start a Debian 13 or Fedora 42 host (privileged, `--systemd=always`, podman-in-podman), install
  v1 (checks at :929-935), release v2 and upgrade (:948-954), killed worker restarts (:958), broken
  v3 rolls back (:960). No backup phase. Checks are sync functions using `inHost` (:100) and
  `expectThat` (:141).
- Image sources: our 14 images are built and pushed to a throwaway Zot. Third-party images come
  from upstream in the host: Docker Hub (caddy, grafana, garage `dxflrs`, mediamtx `bluenviron`),
  ghcr.io (valkey), quay.io (prometheus), plus the host base images (Debian from docker.io, Fedora
  from quay.io, Zot from ghcr.io). `--registry` / `apply_registry` (`selfhost.sh:560-571`) only
  moves **our** images.
- CI: `selfhost-e2e` (`ci.yml:248`), matrix debian/fedora on `ubuntu-24.04`, rootful Podman 4.9
  outside, skipped on pull requests; `ci-ok` depends on it.
- `stack.int.test.ts` runs its own compose project with shifted ports; `run()` defaults to 120 s
  (:54-67); the migrate test is the slow one.

## Build

1. **ExecStopPost order in the generated unit.** In the e2e, after install and after upgrade:
   `systemctl --user cat commonair-<unit>.service` for every `RestartMode=direct` unit, parse the
   `ExecStopPost=` lines in order, and expect the order `cgroup-reset.sh`'s header requires. Read
   that header and the generated unit on both distros first, and write down the order you see:
   the test asserts the order the fix depends on, not a guess. Put the parser in a pure,
   unit-tested function.
   Also a fast test in `quadlet-order.test.ts` that runs the generator
   (`/usr/libexec/podman/quadlet -dryrun -user` with `QUADLET_UNIT_DIRS`) when it is present and
   skips with a reason when not (macOS dev machines), so CI's static group catches a reorder
   before the e2e does if the runner has Podman.
2. **stack.int.test.ts**: give the migrate test headroom (measure: the time alone and under load;
   set the limit to about twice the worst you see, with a comment). If the slowness is in the
   test (for example a second full migrate where a role check would do), fix the test instead.
3. **Pull-through mirror for local runs.** Optional for CI (CI runners are unaffected), on by
   default locally, off with a flag: a Zot (already pinned and used, `e2e.ts:51`) configured as a
   pull-through cache for docker.io, ghcr.io and quay.io, kept between runs in `.cache/`, and a
   `registries.conf.d` mirror entry in the host (the e2e already writes one for Zot, :322). Digests
   still pin every image, so a mirror cannot change what runs. Zot's sync/on-demand extension is
   the feature to check, at the pinned Zot version.
4. **Wire in the other units' checks**:
   - R0-a's `checkIrcClientAddresses(inHost, expectThat)` after `checkClientAddresses` in the
     install and upgrade steps, and remove 6667/6697 from whatever R0-a's report says.
   - R0-b's external store: a second install variant. Choose between a new phase on the same host
     (uninstall, then install with the external flags) and a matrix variant (`--storage external`
     on one distro only, to keep CI time). Explain the choice with times.
   - R0-c's `e2e-backup.ts` (if it has landed; if not, leave a marked hook and say so): a backup
     phase before the rollback step: database backup, `backup --objects`, object restore.
     Record each new step's time in the timings table the e2e prints.

## Tests you must add

- Unit tests for every pure function you add (the `ExecStopPost` parser with Quadlet output from
  both distros as fixtures, the mirror config writer).
- The e2e itself is run by the user (it needs a privileged Podman and about 30-60 minutes): give
  the exact commands for each distro and variant, locally and how to trigger CI.

## Done means

Follow `.claude/briefs/_done-means.md`: your unit tests, `bun --bun vp test run infra/tests/stack.int.test.ts`
only if the data services and Podman are up (else say so), `bunx tsc -p scripts/selfhost --noEmit`,
`vp lint --deny-warnings`/`vp fmt` on your paths. Commit in your worktree. Final message: the
`ExecStopPost=` order you observed (and where), the migrate test timings, the mirror design,
which checks you wired where, test counts, branch and sha, contract requests, and the e2e commands.
