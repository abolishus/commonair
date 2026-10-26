<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# R0-d: unit ordering, operator drop-ins and the Postgres health LOWs

You are implementing unit R0-d for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/R0-release.md`,
`.claude/briefs/r0/README.md`, `infra/README.md` and `docs/self-hosting/README.md`. Do not look
outside the repository. **Wave 2:** start your worktree from the commit that has R0-a and R0-b
merged (the orchestrator names it), on a branch named `r0/d-units`.

## Why

Three small reliability problems in the Quadlet units, each found in review or on the rc droplet:
an optional observability service in a crash loop delays every app service; the docs say operator
drop-ins break `install`/`upgrade` (the code says otherwise, and nobody has proved either); and the
Postgres health script has two open review LOWs (no signal escalation for a stuck start, state in
`/tmp`).

## You own (write only these)

- `infra/quadlet/*.container`: the `[Unit]` dependency lines (`Wants=`, `After=`, `Requires=`)
  and anything in `[Service]` your fixes need. R0-a and R0-b changed these files in wave 1;
  keep their lines.
- `infra/postgres/health.sh`
- `infra/tests/quadlet.test.ts`, `infra/tests/postgres-health.test.ts`,
  `infra/tests/postgres-health.int.test.ts`, new `infra/tests/dropins.test.ts`
- `scripts/selfhost.sh`: **only** `install_units` (:784-810), and only if the drop-in test shows
  a real bug there.

## Contracts you must honor (read-only for you)

- `quadlet.test.ts`'s rules stay (they are the review's findings): every `Requires=`/`Wants=`
  has a matching `After=` and names an existing unit (:207), no cycles (:222), `Requires=` only
  on one-shots, long-running dependencies are `Wants=`+`After=` (:241-253), no `BindsTo=` or
  `Requisite=` (:255). If a rule must change, change it deliberately and say why.
- `RestartMode=direct` units keep exactly one `ExecStopPost=` (the cgroup reset, :102-111);
  R0-e adds a test of its order in the generated unit.

## What is there today (verified at `8bbdb52`)

- `docs/self-hosting/README.md:86-87`: "An optional service in a crash loop can hold back the
  others. App units start `After=` the OpenTelemetry collector, so a collector that never gets
  healthy delays their start."
- `Wants=`+`After=commonair-otel-collector.service` in chat, api (:20-21), media, irc, origin,
  tracker, worker (:15-16 unless noted). The collector `Wants=`+`After=` loki and tempo; grafana
  `Wants=`+`After=` prometheus, loki, tempo. The collector, loki and tempo have `Notify=healthy`,
  so `After=` waits for them to be **healthy**, not just started.
- Drop-ins: `install_units` deletes only files and symlinks matching `commonair*` and keeps
  directories, with the comment "Operator drop-ins (commonair-<unit>.container.d/, e.g. for a
  GPU) are directories and stay" (:787-790); the same for `~/.config/systemd/user` (:796).
  `backups.md:362` agrees. `README.md:80-83` says the opposite ("a drop-in directory there … makes
  them fail. There is no supported way to customize a unit yet."). The `*.container` globs at
  :814, :822, :861 do not match `.container.d`.
- `infra/postgres/health.sh`: `--startup` tracks a progress marker in
  `${COMMONAIR_PG_HEALTH_STATE:-/tmp/commonair-pg-health.state}` (:33, written at :74 through
  `$state.tmp` + `mv`). On a stall it sends `kill -QUIT "$pid"` to the postmaster (:92) or
  `kill -TERM 1` (:94), with no follow-up. LOWs: PROGRESS.md:393-400, :468-469.

## Build

1. **Observability never holds back the app.** App units keep `Wants=` on the collector (so it is
   started) but must not wait for it to be healthy. Options: drop `After=` (then the "every
   `Wants=` has an `After=`" rule needs a named exception for observability units, with the
   reason in the test), or keep `After=` and have the collector unit become "started" before it
   is healthy. Check what the OTel SDK does when the collector is not up yet (it should buffer or
   drop, never block or crash: find it in `packages/observability/src/sdk.ts`) and pick the
   option that keeps telemetry from the first seconds where possible. The same for grafana on
   prometheus/loki/tempo.
2. **Drop-ins, proven.** A test that renders the units into a temp `~/.config/containers/systemd`
   with an operator drop-in directory (`commonair-media.container.d/gpu.conf`) and one under
   `~/.config/systemd/user/commonair-backup.service.d/`, runs `install_units` twice (install and
   an upgrade with one unit removed from the release), and asserts the drop-ins survive and the
   removed unit is gone. Run the real function (source the script with a test hook, or extract it
   if the script already has a pattern for that); if you find a bug, fix it in `install_units`.
   Then tell R0-f the supported way to customize a unit, for the README.
3. **health.sh**: state moves out of `/tmp` to a path in the container that does not survive a
   container restart in a stale way (the container's `/run` or the data volume? decide: a stale
   marker from a previous container must not make a fresh start look stalled). Escalation: after
   `kill -QUIT` (or `TERM 1`), wait a bounded time (`COMMONAIR_PG_KILL_GRACE_SECONDS`, default 30) and send `KILL` if the process is still there. Keep the exit codes.
4. Note for R0-f the doc changes: README.md:80-83 (drop-ins) and :86-87 (crash loop).

## Tests you must add

- `quadlet.test.ts`: app units do not wait for observability health (the rule you chose), with
  the existing rules still passing.
- `dropins.test.ts` as above.
- `postgres-health.test.ts`/`.int.test.ts`: escalation to KILL after the grace period with a
  process that ignores QUIT; the state path; a stale marker from an earlier container is ignored.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun --bun vp test run infra/tests` (the `.int` files
only with the data services up), `vp lint --deny-warnings`/`vp fmt` on your paths, `shellcheck`
on the shell files if installed. Commit in your worktree. Final message: the ordering option you
chose and why, test counts, branch and sha, contract requests, R0-f doc changes.
