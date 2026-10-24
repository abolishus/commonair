<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# R0: from rc.1 to `v0.1.0`

**Goal.** A stranger can install a signed release on a fresh Debian 13 or Fedora 42 server with a
real domain, get a Let's Encrypt certificate, upgrade it, back it up and restore it, following
only `docs/self-hosting/`.

**State.** `ci-ok` green on main (run 39994146130, `cbc8786`; again at `ef9f2b3`). The tag
`v0.1.0-rc.1` is signed locally on `ef9f2b3` and not pushed.

## 1. The user's steps (PROGRESS.md "User to run (Part 3)")

1. Branch protection on `main` requiring `ci-ok`; tag protection for `v*`.
2. `git push origin v0.1.0-rc.1`; watch `release.yml`.
3. Make each `ghcr.io/abolishus/commonair/<image>` package public.
4. Verify with `docs/self-hosting/verifying.md` against `release.yml@refs/tags/v0.1.0-rc.1`.
5. Clean Debian 13 VM with DNS: `selfhost.sh install --version v0.1.0-rc.1 --domain … --email …
   --yes`; in a browser check TLS, an avatar upload, an export download.

Every place the docs are wrong is a finding: fix the doc or the code, then rc.2.

## 2. Code work (Claude, in a worktree, one batch)

| Unit         | Owns                                                                                             | Build                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R0-a irc-fds | `services/irc/**`, `infra/quadlet/commonair-irc*`                                                | systemd socket activation for 6667/6697 (`LISTEN_FDS`, `Bun.listen({ fd })`, plan at `infra/README.md:394`), so IRC sees real client addresses; e2e check that two source addresses are two clients                                                          |
| R0-b s3-ext  | `scripts/selfhost.sh` (S3 section), `infra/selfhost/env/*`, `docs/self-hosting/configuration.md` | `--s3-endpoint/--s3-bucket-*` for an external S3 store instead of Garage; Garage units not installed then; `upgrade` keeps the choice                                                                                                                        |
| R0-c backups | `scripts/selfhost.sh` (backup), `docs/self-hosting/backups.md`                                   | `selfhost.sh backup --objects` runs the rclone recipe; drill bucket name from config; rclone remote with `no_check_bucket` (unit H LOWs)                                                                                                                     |
| R0-d units   | `infra/quadlet/**`, `infra/postgres/health.sh`                                                   | the observability crash loop no longer holds starts behind `After=` (`docs/self-hosting/README.md:86`); operator drop-ins under `~/.config/containers/systemd/*.d/` survive upgrades; unit D LOWs (signal escalation for a stuck start, state out of `/tmp`) |
| R0-e tests   | `infra/tests/**`, `scripts/selfhost/e2e.ts`                                                      | test that Quadlet keeps the unit's `ExecStopPost=` order; `stack.int.test.ts` limit with headroom; optional pull-through Zot mirror for local e2e runs (Docker Hub rate limit)                                                                               |
| R0-f docs    | `docs/deploy/hetzner.md`, `docs/self-hosting/**`                                                 | drop the stale IPv4-only and client-address limitations (`hetzner.md:173`); fork upgrades (`COMMONAIR_REPOSITORY_URL`) documented                                                                                                                            |

R0-a and R0-b both touch the e2e; give the e2e file to R0-e and have the others add check
functions in their own files that R0-e wires in.

## 3. Real-server checks only a VM can do

- ACME issuance and renewal (the e2e uses `--tls internal`).
- SELinux on Fedora 42: the e2e host has no `/sys/fs/selinux`, so `:z`/`:Z` labels are untested.
  One Fedora VM install with SELinux enforcing.
- arm64 on a real arm64 server (Hetzner CAX).
- `selfhost.sh upgrade --version v0.1.0-rc.2`, `backup`, `status`, and a restore of that backup
  onto a second VM (ADR 0010 calls a tested restore a launch blocker).

## Done means

- rc.2 cut from a green `ci-ok`, installed fresh on Debian 13 (amd64) and Fedora 42 (arm64,
  SELinux enforcing) with ACME, upgraded from rc.1, backed up and restored.
- The two intermittent CI failures (ingest-whip, integrity-basic; PROGRESS.md "Still open") have
  either recurred and been fixed from their new diagnostics, or not recurred in ten main runs.
- `v0.1.0` tagged from the same commit as the last good rc; ROADMAP.md says Phase 1 shipped.

## Out of scope

MediaMTX RTMP/ICE client addresses (no socket activation there; documented). Multi-host.
