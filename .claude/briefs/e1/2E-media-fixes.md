You are fixing **open media review findings (2E round three)** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, HANDOFF.md ("Open review findings" → Media), PROGRESS.md (2E row), PLAN.md and
docs/architecture.md first. Do not look outside the repository.

## You own (write only these)

- `services/media/**`, `infra/mediamtx/**`

## Contracts you must honor (read-only for you)

- `packages/contracts` (internal contract, events), `packages/db` schema (vods, clips, simulcast
  targets, thumbnails), `packages/config`, `packages/storage`. Changes there are contract requests.

## Fix (each with tests)

1. Stale `processing` VODs: on startup and periodically, reconcile VODs stuck in `processing`
   (no live worker owns them) → resume or mark failed with a reason.
2. Crash recovery of recordings + work-dir sweep: on startup, finalize or discard partial
   recordings left in `MEDIA_WORK_DIR` by a crash; sweep orphaned work directories older than a
   threshold.
3. Global disk budget for the work dir (configurable via existing env if present; otherwise a
   constant + contract request for an env var): refuse new recordings/clips with a clear event
   when over budget, never crash.
4. Transcode slot limit: cap concurrent ladder transcodes (per host, configurable), queue or skip
   with a stream-health warning.
5. Simulcast: SSRF protection (DNS-resolve and refuse private/loopback/link-local/CGNAT/metadata
   ranges, IPv4+IPv6 incl. mapped), protocol whitelist (`rtmp`, `rtmps` only), generic errors to
   users (details only in logs, no secrets).
6. Simulcast stream key out of ffmpeg argv (visible in `ps`): pass via a file/fd/stdin-config
   mechanism ffmpeg supports, or an `-i` from a FIFO/env-expanded URL file; document the choice.
7. Thumbnail history cleanup: keep the latest N per channel/broadcast, delete older objects.

## Tests you must add

- Unit tests for pure pieces (budget accounting, slot limiter, URL/IP validation, argv builder
  contains no secrets). Integration tests (`*.int.test.ts`) for reconcile, crash recovery and
  thumbnail cleanup against real Postgres + Garage (`bun scripts/infra.ts test` starts both).

## Done means

- `bun run verify --quick` passes plus `bun run --filter @commonair/media test:int` (never drop
  databases you did not create; poll with generous deadlines, no tight wall-clock asserts).
- No files outside your paths changed (`git status`).
- Commit in your worktree (Conventional Commits, `git commit -s`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Final message: each finding → fixed / not fixed (why), test counts, contract requests.
