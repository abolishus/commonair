<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-f balancer and pooler: several app hosts behind one address, and one Postgres behind them

You are implementing unit S1-f for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- [ADR 0032](../../../docs/decisions/0032-scaling-and-availability.md) §5 (the layer 4 load
  balancer), its "Notes from S1-c" (chat drains on SIGTERM, never SIGKILL) and the connection
  budget row in §1. [ADR 0041](../../../docs/decisions/0041-launch-scale.md) decisions 2, 3 and 5.
- `.claude/briefs/s1/launch-contract-step.md`: `DATABASE_PREPARE` (§2) and internal addressing
  (§4).
- `infra/tofu/README.md`, the "gaps" list: no UDP health check on the network load balancer, and
  UDP client addresses unconfirmed. Both are yours to settle.
- ADR 0022 and ADR 0002 (vetting and licenses), because this unit adds a container image.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository, except DigitalOcean's and PgBouncer's own documentation for
the facts Build 1, 5 and 6 name; record each with the date you checked it. This is **wave 1**:
work in your own git worktree, on branch `s1/f-balancer-pooler`, cut from the contract step's
sha. S1-j, S1-e and S1-n run beside you.

## Why

The launch runs at least two app hosts behind a load balancer and grows the pool automatically
(ADR 0041 decision 3). Three things do not survive that today:

- **No drain.** `runService` (`packages/service/src/server.ts:75-130`) sets `stopping` and stops
  the server in the same call, so the load balancer learns of a shutdown only by failing
  requests. Web's health is a constant (`apps/web/src/server/http.ts:91`).
- **Certificates.** Every app host runs Caddy and would each try to obtain the site's
  certificate.
- **Connections.** Each host's services open `DATABASE_POOL_MAX` connections each. A
  `db-s-1vcpu-2gb` node allows 47 (ADR 0032 §1), which one host already nearly fills.

## You own (write only these)

- `packages/service/src/server.ts` and its tests.
- `apps/web/src/server/http.ts` (health routes only) and `apps/web/server.ts` (shutdown only).
- The readiness and shutdown wiring of each service: `services/{api,origin,worker,tracker}/src/main.ts`
  and `services/chat/src/server.ts` (its `draining` flag, `:151,409,534`), only for health and
  drain.
- `infra/caddy/**`, except the WHIP route, which S1-e changes: apply S1-e's diff if the
  orchestrator hands it to you.
- `infra/pgbouncer/**` (new), `infra/quadlet/commonair-pgbouncer.container` (new),
  `infra/selfhost/env/commonair-pgbouncer.keys` (new), and the `pgbouncer` service in
  `compose.yaml` (that service block only).
- `infra/image-licenses.json` and `supply-chain.json`, only the entries for the pooler image.
- `infra/tofu/digitalocean/modules/instance/{app_tier,managed_state}.tf` and
  `tests/{stage1,stage2}.tftest.hcl`.
- `docs/self-hosting/managed-services.md` (a pooler section) and `docs/operators/load-balancer.md`
  (new).

**Read-only:** `packages/db/**` and `packages/config/**` (the contract step added
`DATABASE_PREPARE`), `scripts/selfhost.sh` and the rest of `infra/quadlet/**` and
`infra/selfhost/**` (S1-n's: it installs your unit, so send it the unit name, its mode rule and
its env keys as a contract request), `services/media/**`, the other tofu files (S1-k's in wave 2).

## Contracts you must honor

- Real client addresses reach the rate limiter. Services trust `X-Forwarded-For` only from
  `TRUSTED_PROXY_CIDRS` (`packages/config/src/env.ts:70`), and Caddy trusts no forwarded header.
  The network load balancer passes addresses through with no PROXY protocol
  (`app_tier.tf`: `REGIONAL_NETWORK`, `enable_proxy_protocol=false`).
- A single-host install is unchanged: no pooler unit, same shutdown time or shorter, same
  health routes.
- Migrations always use a direct connection (`packages/db/src/migrate.ts`), never the pooler.
- No secret in a unit file, a log line or a command line.

## Build

1. **Settle the load balancer's open facts first**, on a staging instance through the user, and
   record them in `load-balancer.md`:
   - UDP 443 (HTTP/3) and whether the client address is preserved;
   - what happens to open TCP connections (RTMP, IRC, WebSocket) to a host that starts failing
     its health check;
   - whether a health check can be HTTP on a port the balancer does not forward.
     If UDP addresses are not preserved, HTTP/3 is switched off at the balancer and the doc says
     so. Give the user the exact commands; do not run them.
2. **A draining state.** On SIGTERM a service:
   - marks itself draining, and `/readyz` returns 503 with a body that says `draining`;
   - keeps serving for a drain window that covers the balancer's detection time (interval ×
     unhealthy threshold, plus margin), from one shared setting;
   - then stops as today. Chat closes its `MessageWriter` and flushes before exit (ADR 0032,
     Notes from S1-c). Its `draining` flag feeds `/readyz` too.
   - `/healthz` stays 200 while draining: the process is alive.
   - Web gets a real readiness check and the same drain.
3. **A health route for the balancer.** Caddy serves one path that is healthy only when Caddy is
   up and the local api, web and origin are ready and not draining. `app_tier.tf`'s check moves
   from TCP 443 to that route, if Build 1 allows it. It returns no data and is not rate-limited
   by client address in a way the balancer's own checks could trip.
4. **Certificates across app hosts.** Decide, record in ADR 0041 as a contract request, and
   build:
   - every Caddy must serve the same certificate without each host racing ACME for it;
   - candidates: shared certificate storage through a Caddy storage module (a new dependency:
     vet it and its license at the pinned version), a DNS-01 challenge with a provider adapter
     (proprietary services are optional adapters), or one host obtaining the certificate and the
     others fetching it over the internal network, as `infra/irc/sync-cert.ts` already does for
     IRC;
   - the FOSS default must work with no DNS provider API.
5. **The tracker and IRC.** The tracker stays a single instance on one app host (ADR 0032,
   decisions at acceptance). Caddy on every other app host proxies `/tracker*` to that host's
   internal address. Check that IRC (6697) through the balancer keeps client addresses.
6. **The pooler.**
   - **Provider's pool:** `managed_state.tf` gains a transaction-mode connection pool for the app
     role, sized from the node's limit, and outputs its URL. The owner's direct URL stays for
     migrations.
   - **Bundled pool:** a PgBouncer unit for operators whose provider has none. Vet the image
     with the repo's rules (pinned `name:tag@sha256:…`, license recorded, no install scripts),
     in transaction mode, TLS to Postgres verified with the operator's CA, auth without a
     plaintext password file readable by other units.
   - `DATABASE_PREPARE=false` behind either. The contract step made `createDb` honor it.
   - Prove the code is safe in transaction mode. The survey at `14c3c83a` found no `LISTEN`, no
     session advisory locks outside `packages/db/src/testing.ts`, no session `SET`, no temp
     tables, and 49 uses of `pg_advisory_xact_lock`, which is transaction-scoped. Re-run that
     search, list the result in `managed-services.md`, and add a lint or test that fails on a
     new session-level use.
   - `connection.application_name` is a startup parameter: check PgBouncer accepts it.
7. **The connection budget.** Document the formula with a pooler: client connections per host,
   server connections in the pool, the direct connections migrations and backups need. Send
   S1-n the preflight change for `infra/selfhost/state-check.ts` as a contract request.

## Edge cases

- SIGTERM during startup, before readiness was ever true.
- A second SIGTERM during the drain window stops at once.
- A WebSocket or an HLS long-poll open at the end of the window.
- A worker mid-job at SIGTERM: the job finishes or is returned to the queue, as today.
- The pooler restarting under load: clients reconnect with the existing backoff
  (`packages/db/src/client.ts`).
- A transaction longer than the pooler's timeouts (reports, exports).
- Certificate renewal while one host is being replaced.

## Tests you must add

- Unit tests for the drain state machine in `packages/service` (each signal order, the window,
  the double signal) and for web's readiness.
- An integration test per service that readiness goes 503 on SIGTERM while a request in flight
  still completes.
- **Pooler integration:** run `packages/db`'s integration suite, and one money and one chat
  suite that use `pg_advisory_xact_lock`, through PgBouncer in transaction mode with
  `DATABASE_PREPARE=false`. Send the CI wiring as a contract request.
- Tofu tests: the pool resource exists at stage 1, and the health check at stage 2 is the new
  route.
- A Caddyfile test for the health route and the tracker proxy, in the style of the existing
  infra tests.

## Reviewer focus

- Client addresses are real at the rate limiter, with no new trusted proxy.
- Draining is visible to the balancer before the first request fails.
- Chat never loses acknowledged messages on a planned stop.
- The pooler image is vetted and pinned, and migrations bypass the pool.
- No session-level Postgres feature slipped through.
- The certificate design has a FOSS default.

## Done means

Follow `.claude/briefs/_done-means.md`: tests for `packages/service`, the services you touched
and `apps/web` (`vp build`), `bun --bun vp test run infra/tests`, `sh infra/tofu/check.sh` if
tofu 1.13.1 is installed (say so if it is not), `bun scripts/vet-package.ts` output or the image
vetting notes pasted, lint, format and `reuse lint`. `git status` shows only your paths. Commit
with `git commit -s`.

Your final message lists: what you built, test counts, the vetting output, the certificate
decision, the staging commands for Build 1 and what they must show, and contract requests
(S1-n's unit install and preflight, the CI wiring, the ADR note).
