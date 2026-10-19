<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing the **E3 relay changes** (Go) for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, HANDOFF.md, docs/architecture.md, `relay/README.md` and
**docs/testing/e3-selectors.md** first. Do not look outside the repository. You work in your own
git worktree: run `git merge main --no-edit` first.

## You own (write only these)

- `relay/**`

## Contracts you must honor (read-only for you)

- `relays.register` / `relays.heartbeat` / `relays.receipt` in
  `packages/contracts/src/api/router.ts` — the heartbeat input now has `draining: boolean`
  (default false). `packages/tokens/vectors.json` and the receipt format must not change.
- Go stdlib only (`relay/module-licenses.json`).

## Build

1. **Draining heartbeat.** On SIGTERM/SIGINT, before/at the start of the drain, send one heartbeat
   with `draining: true` (bounded timeout, best effort, logged on failure), stop sending normal
   heartbeats, keep serving current viewers until `--drain-timeout`, flush receipts for the drain
   period, then exit. `/healthz` already answers 503 while draining.
2. **Re-registration after offline.** When the API answers a heartbeat with status `offline`
   (e.g. the worker timed it out while the relay was paused), the relay re-registers (same token,
   same key) instead of carrying on silently; on `suspended`, it keeps running but logs loudly and
   serves 410 as today. Check what the client does on 401/404/other statuses and make the state
   machine explicit and tested.
3. **Local stack fit** (e3-selectors "Running a relay locally"): plain `http` listen with
   `--public-url http://<LAN IPv4>:<port>` works; startup logs one line with the public URL,
   region, capacity and version (never the token). Add a README section "Run against a local
   stack" with the exact commands (`go build ./cmd/commonair-relay`, the flags, the
   `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` requirement).
4. Check the LL-HLS path with the origin's real playlist shapes (`services/origin/tests` fixtures
   if any): blocking reloads (`_HLS_msn`/`_HLS_part`) pass through, `EXT-X-PART`/`PRELOAD-HINT`/
   `MAP` URIs are rewritten to stay on the relay with the viewer's `?t=`, and CORS covers
   hls.js (Range, OPTIONS). Fix anything missing, with tests.

## Tests you must add

- Drain: a fake API (httptest) receives a heartbeat with `draining: true` on shutdown, then no
  further normal heartbeats; receipts for the drain period are flushed.
- Heartbeat `offline` → re-register; `suspended` → 410 serving; table tests for the client state
  machine.
- Playlist rewrite cases for LL-HLS tags if you change them.
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
