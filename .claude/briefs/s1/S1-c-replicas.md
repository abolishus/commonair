<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-c: the `multi-instance` harness scenario

You are implementing unit S1-c for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/S1-scaling.md`,
[ADR 0032](../../../docs/decisions/0032-scaling-and-availability.md) (proposed) and
`harness/README.md`. Do not look outside the repository. Work in your own git worktree on a
branch named `s1/c-replicas`.

## Why

Stage 2 runs two or more app droplets behind a load balancer. The code was written to be
replica-safe, but nothing has ever run two of anything. This scenario runs two of each app
service in the harness stack and proves, or disproves, each claim ADR 0032 makes, before any
droplet depends on them. A failure here is a finding to report, not something to hide: write the
check, let it fail, and describe the bug with its code path.

## You own (write only these)

- `harness/scenarios/multi-instance.ts` (new)
- `harness/compose.multi-instance.yaml` (new compose override)
- `harness/src/multi/**` (new helpers: replica discovery, kill/restart, a reconnecting chat client)
- `harness/tests/multi-*.test.ts` (new)
- `harness/README.md`: one row in the scenario table and one `multi-instance` section

Read-only: `compose.yaml`, `scripts/infra.ts`, `harness/src/registry.ts`, `harness/src/shards.ts`,
`harness/src/env.ts`, `harness/src/chat-client.ts` and every service. S1-a is changing
`harness/src/load*` and adding to `harness/src/metrics.ts` at the same time: do not touch them.

## Contracts you must honor (read-only for you)

- `defineScenario` (`harness/src/scenario.ts:62-79`): `needs` (use `"podman"`), `inFull`,
  `timeoutMs`, `ctx.step/check/assert/metric/skipStep/defer`.
- The stack: `compose.yaml` + `HARNESS_OVERRIDES` (`scripts/infra.ts:384-388`), started by
  `bun scripts/infra.ts stack --harness`. Services publish fixed host ports
  (`"${BIND_ADDRESS:-127.0.0.1}:${API_PORT:-3001}:3001"`, `compose.yaml:271`), so a replica needs
  its own service entry and port, not `deploy.replicas`. The harness talks to services directly
  on host ports (`harness/src/env.ts:25-43`); Caddy is not in the harness stack.
- Adding your override to the stack (a `--multi` flag or a profile in `scripts/infra.ts`), to the
  full run (`registry.ts` `FULL_REQUIRED`) or to a CI shard (`shards.ts`) is a **contract
  request** with the exact diff. Until it lands, the scenario skips with a clear reason when the
  replicas are not running.

## Replica facts to test (verified at `8bbdb52`)

| Claim                        | Where                                                                                                                                                        | What to check                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox exactly-once          | `services/worker/src/outbox.ts:7,77` (`FOR UPDATE SKIP LOCKED`)                                                                                              | N events produced with two workers each processed once: find an observable side effect per event (a notification row, a webhook delivery to a harness receiver, a ledger entry) and count it                                                                              |
| Recurring jobs once per tick | BullMQ `upsertJobScheduler` (`services/worker/src/runtime/runtime.ts:144-148`), integrity run lock (`integrity/lock.ts:1-13`)                                | a recurring job's runs over a few ticks with two workers equal the tick count                                                                                                                                                                                             |
| One issuance leader          | `services/origin/src/issuance.ts:197` (`SET issuance:lock … NX PX`)                                                                                          | with two origins, relay token issuance happens once per tick (observe through the API or Valkey, not logs if avoidable)                                                                                                                                                   |
| Chat across instances        | `services/chat/src/bus.ts` (Valkey pub/sub)                                                                                                                  | a message sent on chat-1 reaches a client on chat-2 and vice versa, in order per room                                                                                                                                                                                     |
| Shared rate limits           | `services/api/src/index.ts:84` (`valkeyRateLimitStore`)                                                                                                      | the `auth` bucket (10 per minute per address) is shared: 10 across api-1 and api-2 pass, the 11th on either is 429                                                                                                                                                        |
| Chat cache staleness         | `services/chat/src/directory.ts:46-49` (TTL caches, invalidated over at-most-once pub/sub)                                                                   | a ban or a slow-mode change through the API takes effect on both chat instances; record the time per instance as a metric, and check it against the TTL                                                                                                                   |
| Viewer counts                | `services/api/src/lib/viewers.ts:4-6,21` (Postgres, 5 s Valkey cache)                                                                                        | players heartbeating to api-1 and api-2 are counted once each, the same on both                                                                                                                                                                                           |
| Reconnect on instance loss   | the web client reconnects with backoff (`apps/web/src/chat/connection.ts:101-118`); the harness `ChatClient` does not (`harness/src/chat-client.ts:115-118`) | kill chat-2 (`podman kill`), clients on it reconnect to chat-1 (a reconnecting wrapper in `harness/src/multi/` with the web client's backoff, standing in for the load balancer), no message accepted before the kill is lost from history, and record the reconnect time |
| Worker loss                  | —                                                                                                                                                            | kill one worker mid-backlog: the other drains it, nothing processed twice                                                                                                                                                                                                 |

The tracker is **not** replicated (ADR 0032: swarms are in memory, `services/tracker/src/swarm.ts:1-6`).
Run one. Origin replicas each have their own segment cache, which is fine.

## Build

1. **Override**: `api-2`, `chat-2`, `worker-2`, `origin-2` (and `web-2` if the web app has
   per-instance state worth testing; check and decide), each `extends` the original service, with
   host ports from new `*_2_PORT` variables defaulting to free ports. Put them under a compose
   profile (`multi`) so the override can be included in every harness stack without starting
   anything unless asked. Ingest-side services (media, MediaMTX) stay single: that is stage 3.
2. **Replica helpers** (`harness/src/multi/`): find each replica's container with the naming in
   `harness/src/safety.ts:251-260` and `serviceContainers` (`safety-io.ts:255-265`), `podman kill`
   and wait for health (model: `checkRestart` in `scripts/selfhost/e2e.ts:836-867`; the generic
   `podman()` wrapper in `harness/src/drill/podman.ts:171`), and replica URLs from env.
   Restart killed replicas in `ctx.defer` so later scenarios find the stack whole.
3. **The scenario**: one step per row above, each a `ctx.check` (soft) so one finding does not
   hide the rest, with metrics (`multi.chat.cross_latency_ms`, `multi.reconnect_ms`,
   `multi.cache_stale_ms.<kind>`, …). `inFull: true`, skipping with a reason when the replicas are
   not running. Keep it under the default 10-minute timeout.

## Tests you must add

- Unit tests for the pure parts: replica discovery from `podman ps` output, the reconnecting
  client's backoff schedule (deterministic with an injected random), the exactly-once counter.
- Run the scenario against the stack **only if** the user has it running with your override;
  you do not start or stop the stack (`.claude/briefs/_done-means.md`). If it is not up, say so
  and give the exact commands.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun --bun vp test run harness/tests/multi-*`, the harness
typecheck (`bunx tsc -p harness --noEmit`), `vp lint --deny-warnings` and `vp fmt` on your paths.
Commit in your worktree. Final message: test counts, branch and sha, contract requests (the
`scripts/infra.ts`, `registry.ts`, `shards.ts` diffs), the exact commands to start the stack with
replicas and run the scenario, and for each claim in the table whether you could verify it by
reading the code, and any replica-safety bug you found, with the code path.
