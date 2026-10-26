<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0023: Releases and one-command self-hosting

- Status: accepted (2026-10-22)
- Date: 2026-10-22

## Context

PLAN Phase 5: anyone should be able to take a tagged release and get a running instance on a
fresh Linux server with one command, using signed images and binaries that come with
provenance and an SBOM. Before this ADR the Quadlet units referenced `localhost/commonair/*:latest`
images built on the server from a git clone, and setup was the manual steps in
`deploy/hetzner.md` (now [deploy/digitalocean.md](../deploy/digitalocean.md)). ADR 0010 chose the
host; ADR 0025 replaced it. ADR 0022 sets the
supply-chain rules that everything here must follow: Actions pinned to commit SHAs and
third-party images pinned to digests.

## Decisions

The maintainers decided the registry, signing, distro, version and architecture questions
on 2026-10-22.

1. **Versions are semver tags `vMAJOR.MINOR.PATCH[-pre]`**, starting at `v0.1.0`. The first
   tag is `v0.1.0-rc.1`. Image tags and asset names use the version without the `v`. Pushing a
   `v*` tag runs the release workflow. A tag with a prerelease part makes a GitHub prerelease,
   and only stable versions also move the `latest` image tag. Nothing ever pulls `latest`.
2. **Registry: `ghcr.io/abolishus/commonair/<image>`** (`SITE.containerRegistry` + `SITE.slug`),
   plus a documented **mirror recipe**. An operator copies a release into a registry they run
   themselves, such as Zot (Apache-2.0) or CNCF Distribution (Apache-2.0), with `cosign copy`.
   `cosign copy` keeps digests, signatures and attestations, so the units, the manifest and
   signature verification work unchanged against the mirror. Forks publish to
   `ghcr.io/<owner>/commonair` with no code changes, because the workflow derives the
   namespace from the repository.
3. **Signing is keyless** with cosign through GitHub Actions OIDC, Sigstore Fulcio and Rekor.
   There is no long-lived key to store or rotate. Operators verify against the release
   workflow's identity
   (`--certificate-identity-regexp '^https://github.com/<owner>/commonair/\.github/workflows/release\.yml@refs/tags/v'`
   and `--certificate-oidc-issuer https://token.actions.githubusercontent.com`). Every artifact
   must be verifiable with the cosign CLI alone, without GitHub's API, so the trust path does
   not depend on a proprietary service.
4. **Every artifact gets a signature, SLSA build provenance and a CycloneDX SBOM.**
   - Images are signed by digest. The SBOM (CycloneDX JSON) and the SLSA provenance are cosign
     attestations attached to the image in the registry. They are also uploaded to the GitHub
     Release for offline review.
   - Relay binaries get a `.sigstore.json` bundle from `cosign sign-blob`, a CycloneDX SBOM,
     and provenance as a Sigstore bundle asset.
   - `SHA256SUMS` lists every asset and is signed itself (`SHA256SUMS.sigstore.json`).
5. **Release contents.** The released images are the 14 in `RELEASE_IMAGES`
   (`scripts/release/manifest.ts`): every image built from our Containerfiles in compose.yaml,
   plus the relay. Each is built for linux/amd64 and linux/arm64 on native runners, with no
   QEMU, and published as a multi-arch index. Third-party images (Caddy, Garage, MediaMTX,
   Valkey, Prometheus, Grafana) are not rebuilt. They stay digest-pinned upstream (ADR 0022).
   Relay binaries are built for linux, darwin and windows on amd64 and arm64. Release assets:
   - `release-manifest.json`, the contract below.
   - `commonair-selfhost_<version>.tar.gz`, the self-host bundle.
   - `commonair-relay_<version>_<os>_<arch>[.exe]` plus each one's SBOM and signature bundle.
   - `SHA256SUMS` and its signature bundle.
   - Release notes, generated from Conventional Commits since the previous tag.
6. **The release manifest is the contract** between the release pipeline and self-hosting.
   It is `scripts/release/manifest.ts`, owned by the orchestrator: schema 1, version, tag,
   commit, registry, and a digest per image (the multi-arch index). Units are rendered from it
   as `Image=<registry>/<name>:<version>@<digest>`. The units in the repository keep
   `localhost/commonair/<name>:latest`, so building from source still works and the
   compose/Quadlet mirror test stays meaningful. Only the bundle carries rendered units.
7. **Self-host bundle.** `bun scripts/selfhost/bundle.ts --manifest <release-manifest.json> --out <dir> [--registry <r>]`
   writes `commonair-selfhost_<version>.tar.gz`. It contains `selfhost.sh`, the manifest, the
   rendered Quadlet units, the systemd timers, and every config file the units mount. The
   release workflow and the end-to-end test both call it, so what we test is what we ship.
8. **`scripts/selfhost.sh` is the operator's one command.** It is POSIX `sh` and
   shellcheck-clean, with `install`, `upgrade`, `backup` and `status`. It needs no Bun, Node
   or git on the host: anything that needs Bun (`init-env`, model and hash-list setup) runs in
   the release's `tools` image. Supported hosts are **Debian 13** and **Fedora 42+**, both with
   Podman 5. Other distros are refused unless the operator passes an explicit override flag
   and accepts that the host is unsupported. It downloads release assets only over HTTPS from
   the release URL and verifies `SHA256SUMS` before using any of them. When cosign is present
   it also verifies `SHA256SUMS`'s signature, and `--require-signature` makes that mandatory.
   It never pipes a download into a shell. `.env` is written with mode 0600 in a 0700
   directory.
9. **Upgrades go through `selfhost.sh upgrade`, not `podman auto-update`.** This replaces the
   auto-update plan in ADR 0010 decision 5, which cannot order migrations. An upgrade:
   1. downloads and verifies the new bundle;
   2. pulls every image by digest;
   3. takes a WAL-G base backup;
   4. installs the new units;
   5. runs `commonair-migrate` to completion before api and worker start (the units already
      `Requires=`/`After=` it);
   6. restarts the stack and waits for health.

   If health fails, it reinstalls the previous release's units and images and restarts them.
   Migrations are forward-only. The previous release must still run against the new schema,
   so migrations between adjacent releases must be additive (expand, then contract in a later
   release). A failed migration leaves the schema as it was, because each migration runs in a
   transaction. Restoring the pre-upgrade backup is the documented last resort.

10. **Units restart for real.** Every long-running unit gets `RunInit=true` (reaps orphans,
    see the session-ten Postgres fix), `Restart=always` with a `RestartSec`, a start-limit
    window that cannot leave a crashed service down for good, a health check, and
    `HealthOnFailure=kill`, so an unhealthy container is restarted rather than left running.
11. **Caddy TLS.** `TLS_MODE=acme` (the default) gets publicly trusted certificates for
    `PUBLIC_HOSTNAME`, optionally with `ACME_EMAIL` and an `ACME_CA` override such as a
    staging CA. `TLS_MODE=internal` uses Caddy's internal CA for LAN and test hosts. The
    hostname always comes from the instance env, and no domain is written into config.
    These three are `infraEnv` variables in `packages/config`.
12. **CI tools are not product dependencies,** but they follow ADR 0002's OSI rule anyway:
    cosign, syft, cyclonedx-gomod, crane, oras, buildah/podman and Zot (Apache-2.0),
    actionlint and zizmor (MIT), shellcheck (GPL-3.0). Each is pinned to a version and checksum
    or SHA. Release jobs get only the token scopes they need (`contents: write` on the
    publish job, `packages: write` and `id-token: write` where images are pushed and signed,
    `attestations: write` where provenance is stored). No workflow uses `pull_request_target`.

## Consequences

- One command installs a release. Upgrades are ordered and can roll back. The images and
  binaries are verifiable without trusting GitHub's API.
- The manifest and bundle formats are versioned contracts. Changing either is an orchestrator
  change, like `packages/contracts`.
- Keyless signing records each release in the public Rekor log. That is intended: releases are
  public.
- Migrations need care: two adjacent releases must both run against the newer schema.
- arm64 builds need GitHub's arm64 runners. A fork without them can build amd64 only by
  setting `platforms` on a manual run.
