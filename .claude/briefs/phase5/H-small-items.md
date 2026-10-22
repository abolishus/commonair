<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit H: relay Makefile names, Garage object backup, a read-only key for the restore drill

You are implementing unit H of the Phase 5 follow-up for CommonAir (repo:
/Users/joshe/Repos/bcon; you work in your own git worktree, branched from `phase5/validate`).
Read AGENTS.md, `.claude/briefs/phase5/_common.md`, ADR 0023, `docs/self-hosting/backups.md`
and `docs/maintainers/releasing.md` first. Do not look outside the repository.

## You own (write only these)

- `relay/Makefile`, `relay/README.md` (if it documents the Makefile targets)
- `docs/self-hosting/backups.md` (sections "What is not backed up" and the restore drill),
  `docs/self-hosting/troubleshooting.md` (only if needed), `docs/maintainers/releasing.md`
  (only the relay paragraph, if any)
- new `scripts/tests/relay-makefile.test.ts`

## Contracts you must honor (read-only for you)

- `scripts/release/manifest.ts`: `RELAY_TARGETS` (six targets, incl. `windows/arm64`) and
  `relayAssetName(version, target)` (`commonair-relay_<version>_<os>_<arch>[.exe]`).
- `scripts/release/relay.ts`: how the release workflow builds the relay (flags, `-trimpath`,
  ldflags, version). The Makefile's `release` target must produce byte-identical binaries for
  the same version and toolchain, with the same file names.
- Garage v2.4.1 (`infra/quadlet/commonair-garage.container`, `infra/garage/`), the bucket env
  names in `.env.example` (`S3_BUCKET_MEDIA`, `S3_BUCKET_EVIDENCE`, `S3_BUCKET_EXPORTS`,
  `S3_BUCKET_BACKUPS`), and the WAL-G settings in `infra/postgres/walg-env.sh`.
- Do not edit `scripts/selfhost.sh`, `infra/quadlet/**`, `compose.yaml`, `infra/garage/**`
  (report contract requests instead).

## Build

1. **Relay Makefile.** `PLATFORMS` equals `RELAY_TARGETS`; output names follow
   `relayAssetName` with `VERSION` stripped of a leading `v`; the build flags match
   `relay.ts`. Keep `build`, `check`, `test`, `image` working.
2. **Garage object backup** (VODs, clips, exports, sealed evidence). Today backups.md says to
   copy the buckets "on your own schedule". Give the operator a concrete, tested recipe that
   needs nothing beyond the images already pinned in the repository or the distribution's
   packages (prefer `rclone` from Debian/Fedora, or Garage's own tooling): which buckets,
   which keys to use (a dedicated read-only key, see 3), a systemd user timer example, and how
   to restore objects. Note that evidence is sealed (encrypted) and still needs
   `EVIDENCE_PRIVATE_KEY`, and that exports expire and need not be backed up.
3. **Read-only S3 key for the restore drill.** The drill in backups.md restores production's
   base backup onto a scratch server; with the production key the promoted drill database can
   archive WAL into production's prefix. Document creating a read-only Garage key for the
   backups bucket (`garage key create`, `garage bucket allow --read`) through
   `podman exec commonair-garage /garage …` (check the real binary path and v2 CLI syntax in
   the pinned image), and use it in the drill (the drill must also disable archiving, e.g.
   `archive_mode=off`, or point WAL-G at a scratch prefix; say which and why).

## Tests you must add

- `scripts/tests/relay-makefile.test.ts`: parses `relay/Makefile` and asserts `PLATFORMS`
  equals `RELAY_TARGETS` and the output name pattern matches `relayAssetName` for each target;
  if `go` is available, `make -n release VERSION=v0.0.0-test` prints the expected names (skip
  cleanly without `go`).
- For 2 and 3: run the commands you document against the pinned Garage image under podman
  (a throwaway container; the local podman machine is rootless) and paste the transcript in
  your final message. The docs commands must be exactly what you ran.

## Done means

- `bun run verify --quick` passes, plus `cd scripts && bun --bun vp test run
  tests/relay-makefile.test.ts` and `bun scripts/config-reference.ts --check` (the link
  checker covers docs).
- No files outside your ownership list changed.
- Commit on your branch: Conventional Commits, `git commit -s`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Final message: what you built, test counts, transcripts, contract requests, anything left.
