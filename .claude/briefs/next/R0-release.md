<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# R0: from the release candidates to `v0.1.0`

**Goal.** A stranger can install a signed release on a fresh Debian 13 or Fedora 42 server with a
real domain, get a Let's Encrypt certificate, upgrade it, back it up and restore it, following
only `docs/self-hosting/`.

**State (2026-10-26, `35ad653`).** Phase 5 Part 3 is done (PROGRESS.md, session thirteen):

- `v0.1.0-rc.1` (`ef9f2b3`) and `v0.1.0-rc.2` (`8b8a0a2`) are tagged, released by `release.yml`
  and verified against their tag identities. Rulesets protect `main` (`ci-ok`) and `v*`.
- rc.1 installed on a DigitalOcean droplet (`commonair-rc-test`, Debian 13, shared vCPU) with
  ACME, then upgraded to rc.2, backed up and checked with `status`. The rc test host is a
  droplet because of ADR 0025 (accepted 2026-10-26: DigitalOcean for staging and production).
- Found on that host and fixed in rc.2: the cosign install step, blocked SMTP egress, refusing
  root and a session without a user manager. Found and fixed after rc.2 (`6a1983f`): "resend
  verification email" on sign-in and sign-up, avatar and banner upload on the dashboard.

## 1. Decided (2026-10-26)

1. ADR 0025 accepted. Its doc changes are made: `docs/deploy/digitalocean.md`, the self-hosting
   docs and `infra/README.md`, ADR 0010 superseded, Railway's config, bootstrap script and guide
   removed. The Railway project itself is the user's to delete in Railway's console.
2. `commonair-rc-test` is the staging droplet until S1-g's OpenTofu recreates it.
3. `v0.1.0` waits for R0-g (resend verification email): done in `6a1983f`, with the upload UI.

## 2. Code work (Claude, in a worktree, one batch)

| Unit         | Owns                                                                                             | Build                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R0-a irc-fds | `services/irc/**`, `infra/quadlet/commonair-irc*`                                                | systemd socket activation for 6667/6697 (`LISTEN_FDS`, `Bun.listen({ fd })`, plan at `infra/README.md:394`), so IRC sees real client addresses; e2e check that two source addresses are two clients                                                          |
| R0-b s3-ext  | `scripts/selfhost.sh` (S3 section), `infra/selfhost/env/*`, `docs/self-hosting/configuration.md` | `--s3-endpoint/--s3-bucket-*` for an external S3 store (DigitalOcean Spaces is the first real one) instead of Garage; Garage units not installed then; `upgrade` keeps the choice. S1-b builds on this                                                       |
| R0-c backups | `scripts/selfhost.sh` (backup), `docs/self-hosting/backups.md`                                   | `selfhost.sh backup --objects` runs the rclone recipe; drill bucket name from config; rclone remote with `no_check_bucket` (unit H LOWs)                                                                                                                     |
| R0-d units   | `infra/quadlet/**`, `infra/postgres/health.sh`                                                   | the observability crash loop no longer holds starts behind `After=` (`docs/self-hosting/README.md:86`); operator drop-ins under `~/.config/containers/systemd/*.d/` survive upgrades; unit D LOWs (signal escalation for a stuck start, state out of `/tmp`) |
| R0-e tests   | `infra/tests/**`, `scripts/selfhost/e2e.ts`                                                      | test that Quadlet keeps the unit's `ExecStopPost=` order; `stack.int.test.ts` limit with headroom; optional pull-through Zot mirror for local e2e runs (Docker Hub rate limit)                                                                               |
| R0-f docs    | `docs/self-hosting/**` (not `docs/deploy/**`, which ADR 0025's acceptance rewrites)              | fork upgrades (`COMMONAIR_REPOSITORY_URL`) documented; the stale IPv4-only and client-address limitations dropped from the self-hosting docs (the droplet proved both)                                                                                       |
| R0-g resend  | done (`6a1983f`)                                                                                 | `ResendVerification` on /signin and the sign-up screen, 60 s cooldown, neutral answers; `e2e-basic` covers it                                                                                                                                                |

R0-a and R0-b both touch the e2e; give the e2e file to R0-e and have the others add check
functions in their own files that R0-e wires in.

## 3. Real-server checks only a VM can do

Done on the droplet: ACME issuance, rc.1 → rc.2 upgrade, `backup`, `status`. Left:

- **A restore onto a second droplet** from the off-host backup (Spaces), timed: this is the
  launch blocker (ADR 0025 keeps ADR 0010's rule) and the first number for S1's recovery target.
- ACME renewal (certificate valid to 2027-01-22; force a renewal on staging rather than wait).
- SELinux on Fedora 42: one droplet install with SELinux enforcing (the e2e host has no
  `/sys/fs/selinux`, so `:z`/`:Z` labels are untested).
- arm64 on real hardware. DigitalOcean is not our arm64 target (check whether it offers arm64
  droplets at the time); any arm64 cloud VM will do, since arm64 matters for self-hosters, not for
  our instance.
- A rollback on a real host (CI's e2e covers it).

## Done means

- rc.3 (or the last good rc) cut from a green `ci-ok`, installed fresh on Debian 13 (amd64) and
  Fedora 42 (SELinux enforcing), upgraded from the previous rc, backed up, and restored onto a
  second droplet with the time recorded.
- The two intermittent CI failures (ingest-whip, integrity-basic) have either recurred and been
  fixed from their diagnostics, or not recurred in ten main runs. ingest-whip's root cause was the
  hls.js GAP-start wedge (`5e4ce6c`).
- `v0.1.0` tagged from the same commit as the last good rc; ROADMAP.md says Phase 1 shipped.

## Out of scope

MediaMTX RTMP/ICE client addresses (no socket activation there; documented). More than one host:
that is [S1](S1-scaling.md).
