<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing the **E3 harness scenario `e2e-relay`** for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md, HANDOFF.md, docs/architecture.md, the harness README,
docs/testing/e1-selectors.md, docs/testing/e2-selectors.md and **docs/testing/e3-selectors.md**
first, then the existing scenarios (`harness/scenarios/e2e-basic.ts`, `e2e-social.ts`,
`integrity-basic.ts`) and `harness/src` (viewer, viewbot, platform readiness, selectors parsing).
Do not look outside the repository. You work in your own git worktree: run `git merge main
--no-edit` first.

## You own (write only these)

- `harness/**`

## Contracts you must honor (read-only for you)

- `docs/testing/e3-selectors.md` — the scenario steps, test ids and the local relay recipe.
- The relay CLI (`relay/cmd/commonair-relay`, flags in `main.go`) and protocol
  (`relays.register/heartbeat/receipt`, heartbeat `draining`), `@commonair/tokens`
  `signReceipt` + `ReceiptPayload` (for the TypeScript liar relay), `RelayNode`,
  `stream.health`. The web `/relays` page, the player `data-source`, the API relay lifecycle
  (retire vs offline, draining) and the Go relay's draining heartbeat are being built **in
  parallel** by other units against the same contract: build against the contract, not against
  what is on `main` today, and say in your final message which steps you could only check by
  typecheck/unit tests.

## Build

1. **`e2e-relay` scenario** implementing every step of e3-selectors "The `e2e-relay` scenario",
   individually runnable (`bun harness/src/cli.ts run e2e-relay`), registered like the others,
   with `--set` knobs: `relayHost` (override the detected LAN IPv4), `relayPort`, `httpViewers`,
   `browserViewers`, `bots`, `liar` (default true), `drain` (default true), `via=api` (backend
   only: create the relay through the API instead of the web UI, HTTP viewers only).
2. **Relay process helper** (`harness/src/relay.ts` or similar): `go build` into a temp dir (cache
   by source hash), detect the LAN IPv4 (first non-internal IPv4 from `os.networkInterfaces()`;
   clear error if none), free port, spawn with the flags from the recipe, capture logs into the
   scenario report, wait for `/healthz`, SIGTERM + wait on teardown (always, even on failure).
   Readiness for the `relay` need: Go toolchain present (`go version`) and the API accepting
   private relays — pre-check `OUTBOUND_ALLOW_PRIVATE_NETWORKS` by reading the stack's env the
   same way the harness reads others, and stop with an actionable message if it is off.
3. **Liar relay** (TypeScript): a tiny Bun HTTP server answering `/healthz` on the LAN address, a
   generated Ed25519 key, registers through the API with its own token, heartbeats, and every
   receipt interval submits correctly signed receipts claiming 5× the bytes for the sessions the
   harness knows are assigned to it (the harness opens HTTP viewer sessions until some land on the
   liar; those viewers fetch through the **origin**? No — relay-assigned tokens are refused at the
   origin, so the liar must also proxy the HLS requests it is assigned: implement a minimal
   pass-through that pulls from the origin's `/relay-pull/` with its relay token and serves the
   viewer, so issuance accrues honestly while receipts lie).
4. **Assertions and report**: per step, timings (relay active latency, time to first relay
   playback, time to receipts verified, time to suspension, switch-to-origin latency), counts
   (honest/relay-assigned/bots/verified/excluded), and the relay logs on failure.
5. Harness README: the scenario, its needs (Go, `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true`, LAN
   address), knobs, and the exact commands the user runs.

## Tests you must add

- Unit tests for the pure parts: LAN address selection, liar receipt construction (inflated
  bytes, signature verifies with `verifyReceipt`), e3 selectors parsed from the doc (extend the
  existing selector-parsing test), step-plan building from `--set` knobs.
- Do **not** run the scenario against a live stack (the user does); `bunx tsc -p harness
  --noEmit` and the harness unit tests must pass.
## Done means (session four process rules — every brief)

- **Targeted checks only.** The user runs the gate (`bun run verify`), image rebuilds, harness
  scenarios against the live stack, dev servers and every browser/visual check. You do not. Run:
  your packages' `bun run test` and `bun run test:int` (the data services are already up at the
  `.env.example` defaults; never run `podman compose` or `scripts/infra.ts`), `bunx tsc -p <pkg>
  --noEmit`, `vp lint --deny-warnings <changed paths>`, `vp fmt <changed paths>`, `vp build` for
  `apps/web`, `go test ./...` / `go vet ./...` for `relay/`. Do not run several packages'
  `test:int` at the same time (shared Postgres/Valkey load makes timing tests flaky).
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits), message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, once your targeted checks pass.
- Final message: what you built, test counts per package, branch + commit sha, **contract
  requests** (exact changes needed in files you do not own), anything left undone, and the exact
  commands the user should run live to exercise your work.
