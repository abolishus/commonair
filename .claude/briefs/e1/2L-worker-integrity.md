<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **2L-integrity: run the integrity pipeline in the worker** for CommonAir
(repo: /Users/joshe/Repos/bcon). Read AGENTS.md, PLAN.md (Milestones), docs/architecture.md,
ADR 0003 decisions 5 and 8, `packages/integrity/README.md` and `services/worker/README.md` first.
Do not look outside the repository.

## You own (write only these)

- `services/worker/**`
- `harness/scenarios/viewers.ts` and a new `harness/scenarios/integrity-basic.ts` (only these
  harness files)

## Contracts you must honor (read-only for you)

- `packages/integrity` exports: `scoreActiveSessions`, `verifyReceipts`, `excludeFollowBursts`,
  `markEligibleStreamHours`, `recordFetches`, `classifierFromEnv` (read their signatures and
  README; do not change them — report contract requests instead).
- `packages/db` schema, `packages/config` env (`INTEGRITY_DATACENTER_CIDRS_FILE`, `WORKER_*`),
  `packages/contracts` events.
- `services/api` promotes a session to verified on heartbeats only while `scored_at` is null; once
  the scorer runs, its verdict is final. Viewer counts read verified sessions.

## Build

- Schedule the four jobs on the `integrity` BullMQ queue as repeatable jobs: scoring every 15 s,
  receipts every 60 s, follow bursts every 60 s, stream hours every 5 min. One instance of each
  at a time across replicas (BullMQ repeat keys / job ids), bounded batch sizes, structured logs
  with counts (no PII), metrics via `@commonair/observability`.
- Pass `classifierFromEnv(process.env).classifier` to `scoreActiveSessions`; load the CIDR file once
  at startup and on SIGHUP.
- In `src/segments/consumer.ts` `processEntries`, call
  `recordFetches(client, fetches.filter((f) => f.src !== "relay" && f.src !== "cdn"))` after
  `writeAggregate` (check the current integrity signature; it may count distinct segments).
- Job failures retry with backoff and never crash the worker; a stuck job must not block the
  others (separate job names / concurrency).
- Make sure verified-viewer counters the API/web read (`viewers:<channel>` or whatever the API
  uses — read it) stay consistent when the scorer excludes or ends a session.

## Tests you must add

- Unit tests for scheduling config and the fetch filter.
- Integration tests (`createTestDatabase()`, real Valkey): a heartbeating session with recorded
  fetches becomes verified through the scheduled job; a fetch-less one stays pending/excluded; the
  repeat jobs are registered exactly once with two worker instances.
- Harness: make `viewers` pass against the running stack (`bun harness/src/cli.ts run viewers`),
  and add `integrity-basic`: 3 honest browser/HTTP viewers + a fetch-less viewbot swarm; the
  public viewer count converges to 3 and the bots are excluded with reasons.

## Done means

- `bun run verify --quick` passes plus `bun run --filter @commonair/worker test:int`.
- `bun harness/src/cli.ts run viewers integrity-basic` passes against `bun scripts/infra.ts stack`
  (rebuild the worker image: `podman compose build worker && podman compose up -d worker`).
- No files outside your paths changed. Commit in your worktree (Conventional Commits,
  `git commit -s`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Final message: what you built, test counts, scenario results, contract requests.
