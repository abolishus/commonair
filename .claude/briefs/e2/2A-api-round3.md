<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **API round 3** for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
HANDOFF.md ("Open items"), PLAN.md and docs/architecture.md first. Do not look outside the
repository. You work in your own git worktree: run `git merge main --no-edit` first.

## You own (write only these)

- `services/api/**`

## Contracts you must honor (read-only for you)

- `packages/contracts` (new on main: `@commonair/contracts/auth` with `AUTH_ROUTES` and
  `ALTCHA_FIELD`; `E.APPEAL_SUBJECTS`; `appeals.create` input `subjectType` is now that enum),
  `packages/db` schema (`appeals`, `playback_sessions`, `stream_keys`, `integrity_flags`,
  `audit_log`, `events`), `packages/config`, `packages/integrity` (read `src/allowance.ts`: it reads
  overturned integrity appeals by `subject_type in ('session','user','integrity_flag')` and
  `resolved_at`), `packages/safe-regex` (another unit is changing its cost model in parallel; only
  import it). Any change needed there is a contract request, not an edit.

## Build (each with tests)

1. **Heartbeat floor returns early** (`src/routes/playback.ts`, heartbeat handler): a beat sooner
   than `MIN_HEARTBEAT_WALL_SECONDS` must not increment `heartbeats`, bytes, stalls, update
   latency/fingerprint, or record verification evidence (Valkey verify state) — return `{ ok: true }`
   before any write. Test that a burst of sub-floor beats changes nothing in Postgres or Valkey.
2. **Canonicalize IPs before hashing**, in both `src/http.ts` (`ipHash`, `rateLimitHash`) and
   `src/media/hooks.ts` (`last_used_ip_hash`): unwrap IPv4-mapped IPv6 (`::ffff:1.2.3.4` →
   `1.2.3.4`), lower-case and compress IPv6 (RFC 5952), strip zone ids. One shared helper (e.g. in
   `src/lib/netrange.ts`) with exhaustive unit tests; the same client must hash identically on
   both paths (integrity's owner-IP exclusion compares them).
3. **`pinnedGet` total timeout** (`src/lib/outbound.ts`): the existing `timeout` is an idle-socket
   timeout; add a hard overall deadline (connect + TLS + headers) that destroys the request, and
   test it against a local server that trickles bytes.
4. **P2P sessions are `assignedSource: "p2p"`** (`src/routes/playback.ts`): when P2P is enabled
   for the session (instance `P2P_ENABLED` and the client/assignment allows it — read the current
   assignment code), record `assignedSource: "p2p"` so integrity does not hold heavy-P2P viewers at
   pending. Keep relay/CDN assignment precedence as is. Test.
5. **Appeals** (`src/routes/appeals.ts`, replace the 501 stub): `create` (signed-in user; the
   subject must exist and concern the appellant: an integrity flag on their session/user/channel,
   their own session, or their own user; `kind = integrity` only allows subject types
   `session|user|integrity_flag`; other kinds may stay `NOT_IMPLEMENTED` for subjects whose tables
   are not wired yet — document which), `mine`, `queue` (platform mods, paginated, status filter),
   `resolve` (sets `status`, `resolution`, `resolver_id`, `resolved_at = now()`; refuses
   re-resolving a closed appeal with `CONFLICT`; writes an `audit_log` row and an `events` outbox
   row in the same transaction). Never put appeal body text into audit `details` (ADR 0004).
   Integration tests: create → resolve overturned → `packages/integrity` allowance lookup sees it.
6. **Stream key `last_used_at` per broadcast**: confirm `src/media/hooks.ts` sets it once per
   broadcast start (it appears to at line ~118); add a test if missing.
7. **Document the `mail` rate-limit bucket** in `services/api/README.md` (per template per
   mailbox, 10/hour, HMAC'd subject).
8. Switch any hardcoded better-auth path in `services/api/src/http.ts` (e.g. the ALTCHA challenge)
   to `AUTH_ROUTES` from `@commonair/contracts/auth`.

## Tests you must add

- Unit: IP canonicalization corpus; pinnedGet deadline. Integration (`*.int.test.ts`,
  `createTestDatabase()`): heartbeat floor no-op; P2P assignment; appeals flow incl. audit/outbox
  rows and the allowance lookup.

## Done means

- `bun run verify --quick` passes and `cd services/api && bun run test:int` passes (data services
  are up at the `.env.example` defaults; do not run `podman compose`).
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits, `fix(api): …`/`feat(api): …`),
  ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, only when the gate is green
  (check the exit code).
- Final message: what you built, test counts, branch + commit sha, contract requests (exact
  changes needed in files you do not own), anything left undone.
