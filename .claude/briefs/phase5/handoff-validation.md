<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Handoff: validate and finish Phase 5 (release and self-hosting)

You are the head agent finishing Phase 5 of CommonAir (repo: `/Users/joshe/Repos/bcon`). Phase
5 is built, reviewed and pushed on `main`, but none of it has run end to end. Your job:

1. Prove the work, fixing what breaks.
2. Close the self-hosting gaps listed below.
3. Cut the first release candidate.

## Read first

- AGENTS.md, all of it: ownership, DCO, Co-Authored-By trailer, worktrees, and "nothing is
  committed red".
- PLAN.md "Phase 5" and "Milestones" (how we work).
- PROGRESS.md "Session eleven". It lists what was built, every review finding, the open gaps
  and the run list this document expands.
- ADR 0023 (release and self-hosting decisions), ADR 0022 (supply-chain pins), ADR 0010
  (Hetzner).
- `.claude/briefs/phase5/` (`_common.md`, A, B, C): the contracts each part honours.
- `docs/self-hosting/` and `docs/maintainers/releasing.md`. Follow them as written. Every
  place they are wrong is a finding: fix the doc or the code.

## Working rules

- **Use git worktrees for all edits.** The user often has uncommitted work in the main
  checkout. Never edit, stash or reset it. Branch from `main`, and fast-forward or merge into
  `main` only when the main checkout's dirty files do not overlap yours (`git status` first).
- **Validate with targeted tests.** `bun run verify` is the gate before every commit. It
  needs network for `bun audit`, OSV and govulncheck. Long runs (the e2e, verify) go in the
  background.
- **Review before merge.** Every code fix gets an independent reviewer subagent. Anything
  touching `scripts/selfhost.sh`, workflows or units also gets a security reviewer. Fix every
  HIGH and have it re-reviewed before merging. Use the Workflow tool in batches of at most
  three units, each in its own worktree.
- Conventional Commits, `git commit -s`, and the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Ask the user before anything outward-facing that is hard to undo:**
  - pushing a `v*` tag, i.e. a real release (keyless signing writes to the public Rekor log);
  - changing branch protection;
  - making ghcr packages public;
  - creating cloud VMs that cost money.
    Dry runs, and pushes of verified `main`, are fine.
- Update PROGRESS.md "Session eleven" (or start "Session twelve") as you go: what ran, the
  numbers, each fix as symptom → root cause → fix with its commit.

## Part 1: prove what was built

Run these in order. Each failure is fixed at its root cause, with a regression test.

1. **The gate.** `bun run verify` on `main`. Fix anything red first.
2. **Caddy config:** `cd infra && bun --bun vp test run tests/caddy.int.test.ts` (10 tests).
3. **Self-host end-to-end, Debian.** Run `bun scripts/selfhost/e2e.ts` in the background.
   - It takes about an hour: it builds the 14 images, pushes them to a local Zot, builds a
     bundle, and runs `selfhost.sh install` in a privileged Debian 13 systemd container
     (`--tls internal`).
   - It then checks HTTPS through the internal CA and upgrades to a second build, checking
     that migrate ran before api and worker.
   - It kills the worker to prove it restarts, then rolls a broken release back.
   - Logs and `timings.json` go to `.cache/selfhost-e2e/`. `--keep` leaves the container up
     for debugging.
   - It needs a podman machine that allows `--privileged`.
   - It has never run. Expect real bugs in `scripts/selfhost.sh`, `scripts/selfhost/e2e.ts`
     and the units: host checks against real tools, the `runuser` handoff, `fetch-model.js`
     and init-env in the tools image, the IRC-cert one-shot, and `RestartMode=direct` /
     `Wants=` behaviour on a real systemd.
4. **Self-host end-to-end, Fedora:** `bun scripts/selfhost/e2e.ts --distro fedora`. SELinux
   is enforcing there, so watch the `:z` / `:Z` labels.
5. **CI on GitHub.**
   - Push `main`, then watch the `ci` run with `gh run watch`. The jobs to watch are verify,
     `lint-workflows`, the release dry run on main, `selfhost-e2e` and `ci-ok`.
   - Known unknowns from unit A:
     - podman 4.9 on the runners accepting `manifest add oci-archive:`, `--timestamp` and
       `--annotation`;
     - whether `ubuntu-24.04-arm` has podman;
     - the e2e running as root under rootful podman 4.9;
     - an empty service-container `image` expression on real runs.
   - Fix what fails. Use `gh run view --log-failed`.
6. **Release dry run with signing:**
   `gh workflow run release.yml --ref main -f dry_run=true -f sign=true`. Download the
   `release-dist` artifact and check it has:
   - the manifest, which `parseManifest` must accept;
   - the bundle;
   - six relay binaries, each with its SBOM and Sigstore bundles;
   - image SBOMs and provenance;
   - `SHA256SUMS` with `SHA256SUMS.sigstore.json`.

   Then:
   - run `sha256sum -c`;
   - verify the `SHA256SUMS` signature with the dispatch identity (a dry run from `main`
     signs as `release.yml@refs/heads/main`, not as a tag);
   - unpack the bundle and check its rendered `Image=` lines pin the dry-run digests.

## Part 2: close the self-hosting gaps

These come from PROGRESS.md "Session eleven". They are ordered by how much they block a
working instance. Each one is a unit with a brief in `.claude/briefs/phase5/` (AGENTS.md
template, disjoint ownership), a reviewer, and tests. The first one also needs a security
reviewer.

1. **S3 for browsers (blocks a working instance).**
   - The problem: `selfhost.sh` never sets `S3_PUBLIC_ENDPOINT`, and Caddy has no route to
     Garage. So presigned avatar and panel uploads and data-export downloads point at
     `garage:3900` and fail.
   - Design it first. A SigV4 presigned URL signs the host and path, so a path prefix
     stripped by Caddy breaks the signature; a dedicated hostname (for example
     `s3.<domain>`, a second Caddy site proxying `garage:3900` with the Host header kept) is
     the likely answer.
   - Settle the details: install flags, an extra DNS record and certificate, CORS for the
     browser upload, and that only the public bucket prefixes stay reachable (ADR 0009 keeps
     `incoming/` and evidence private).
   - Record the decision in an ADR. Cover it in the e2e: an avatar upload and an export
     download through the internal CA.
2. **Secrets per unit.**
   - The problem: every unit reads the whole `commonair.env`, so Caddy, MediaMTX, Grafana and
     Garage see database passwords.
   - The fix: split it into a secret-free shared env plus per-unit podman `Secret=` entries
     (or small per-unit env files written by `selfhost.sh`).
   - Mirror the split in compose, keep the "Quadlet mirror" test meaningful, and regenerate
     `docs/self-hosting/configuration.md` (`bun scripts/config-reference.ts`).
3. **Client IPs under rootless Podman.**
   - The problem: published ports reach Caddy from the bridge gateway, so per-IP rate limits
     see one client, and `trusted_proxies private_ranges` trusts client-sent
     `X-Forwarded-For`.
   - Options to evaluate: pasta port forwarding that keeps the source address (Podman 5), or
     Caddy on the host network.
   - Prove it in the e2e: two source addresses must be seen as two clients, and a spoofed
     `X-Forwarded-For` must be ignored.
4. **Loopback exposure.** Valkey (no password), the OTel collector, Prometheus and others are
   published on `127.0.0.1`. Unpublish what nothing on the host needs, and give Valkey a
   password.
5. **Postgres after a restore.**
   - The problem: a long WAL replay hits the unit's health kill and its 300 s start timeout.
   - The fix: a recovery-aware health check, or a longer start window. Then simplify the
     manual path in `docs/self-hosting/backups.md`.
6. **Smaller items:**
   - Garage object backup (VODs, clips, exports): document or script it.
   - The restore drill needs a read-only S3 key.
   - Fork upgrades: `release.env` records `SITE.repository.url`; prefer the URL the bundle
     was actually downloaded from.
   - An observability unit in a crash loop delays app starts.
   - IPv6 binds.
   - `MEDIAMTX_RTMP_URL` is unused.
   - `relay/Makefile` targets and names should match `RELAY_TARGETS` and `relayAssetName`.

Re-run Part 1 steps 1, 3 and 4 after Part 2.

## Part 3: the first release candidate (ask the user first)

1. **Prerequisites** (ask the user before each):
   - Branch protection on `main` requires `ci-ok`. Use `gh api` or the web UI.
   - Tag protection for `v*`.
   - arm64 runners are available.
2. **Tag and release.** Confirm with the user, then:
   `git tag -s v0.1.0-rc.1 -m v0.1.0-rc.1 && git push origin v0.1.0-rc.1`. The user may
   prefer a fork. Watch `release.yml`.
3. **Make the images pullable.** After the first real release, each
   `ghcr.io/abolishus/commonair/<image>` package is private. Ask the user to make each one
   public, or do it with their go-ahead.
4. **Verify the release** with every command in `docs/self-hosting/verifying.md`, against
   the real tag identity.
5. **Install on a real host.** On a clean Debian 13 VM with DNS (ask the user which host;
   Hetzner per ADR 0010):
   - follow `docs/self-hosting/install.md` exactly, ending with
     `selfhost.sh install --version v0.1.0-rc.1 --domain … --email … --yes`;
   - expect a healthy instance with a Let's Encrypt certificate;
   - then cut `v0.1.0-rc.2` and run `selfhost.sh upgrade --version v0.1.0-rc.2`, which must
     migrate and restart cleanly;
   - run `selfhost.sh backup` and `selfhost.sh status`.

## Done means

- `bun run verify` is green.
- Both e2e distros pass.
- `ci-ok` is green on GitHub.
- `v0.1.0-rc.1` has signed, attested images, binaries, SBOMs and a GitHub Release that verify
  with the documented commands.
- `selfhost.sh install` on a clean VM gives a healthy instance with TLS, browser uploads and
  export downloads working.
- `selfhost.sh upgrade` to a second build migrates and restarts cleanly.
- The operator guide matched reality at every step, or was fixed where it did not.
- PROGRESS.md records each run, the numbers, every fix, and anything still open.
