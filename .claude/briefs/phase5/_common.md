<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

## Phase 5 rules every unit follows (read all of this)

**Goal.** Anyone can take a tagged CommonAir release and get a running instance on a fresh
Linux server with one command. The release has signed images and relay binaries with
provenance and an SBOM, and CI proves every step on every push to main.

**Read first.**

- AGENTS.md.
- PLAN.md "Phase 5".
- PROGRESS.md "Session ten", including the Postgres PID 1 fix and the worker that Podman did
  not restart.
- docs/architecture.md.
- ADR 0002 (licenses).
- ADR 0010 (Hetzner).
- ADR 0022 (supply chain: Actions pinned to a full SHA with a `# vX.Y.Z` comment, third-party
  images pinned `name:tag@sha256:…`, a 7-day cooldown on any new tool, Action or image
  release).
- **ADR 0023**. It holds the decisions this phase builds on: semver tags, ghcr.io plus a
  mirror recipe, keyless cosign, Debian 13 and Fedora 42+, arm64 required, the manifest and
  bundle contracts, the upgrade order, restart rules and TLS modes.
- docs/deploy/hetzner.md.
- infra/README.md.

**Shared contracts (orchestrator-owned, read-only for every unit):**

- `scripts/release/manifest.ts`: `RELEASE_IMAGES` (14 images), `RELEASE_PLATFORMS`,
  `RELAY_TARGETS`, `DEFAULT_REGISTRY` (`ghcr.io/abolishus/commonair`), `versionFromTag`,
  `isPrerelease`, `releaseManifest`/`parseManifest`, `imageRef`, `relayAssetName`,
  `bundleAssetName`, `MANIFEST_ASSET`, `CHECKSUMS_ASSET`. Its tests are
  `scripts/tests/release-manifest.test.ts`.
- `packages/config/src/env.ts` `infraEnv`: `TLS_MODE` (`acme` | `internal`), `ACME_EMAIL`,
  `ACME_CA`, `PUBLIC_HOSTNAME`, `IMAGE_REGISTRY`, `IMAGE_TAG`. These are also in
  `.env.example`.
- **CLI contracts between units**, fixed here so A and B can work in parallel:
  - `bun scripts/selfhost/bundle.ts --manifest <release-manifest.json> --out <dir> [--registry <r>]`
    writes `<dir>/commonair-selfhost_<version>.tar.gz` and prints its path on stdout. Exit
    code 0 on success. It needs no network and no podman. Unit B owns it, and unit A's release
    workflow calls it.
  - `bun scripts/selfhost/e2e.ts [--distro debian|fedora] [--keep]` is the self-host end-to-end
    test. It needs podman (rootful or a podman machine that allows `--privileged`) and network
    access for base images. It exits non-zero on failure and writes its logs under
    `.cache/selfhost-e2e/`. Unit B owns it, and unit A's CI runs it nightly and on main.
  - `scripts/selfhost.sh` subcommands are `install`, `upgrade`, `backup`, `status` and
    `--help`. Unit B owns it, and unit A's CI runs shellcheck on it.
- Image names: `<registry>/<name>:<version>@<digest>`. `<name>` is a `RELEASE_IMAGES` entry,
  and `<version>` is the tag without its `v`.

**Hard rules.**

- No `pull_request_target`. No `curl … | sh`, in workflows, scripts or docs.
- No secrets in git. Never echo a token, and never interpolate `${{ … }}` from untrusted
  input into a `run:` script (pass it through `env:`).
- Every new file has an SPDX header (scripts and workflows AGPL-3.0-or-later or CC0-1.0, as
  the files around them do; docs CC-BY-SA-4.0). Do not edit `REUSE.toml`: the user has
  uncommitted changes to it. If a file cannot carry a header, report it as a contract request.
- Do not edit `scripts/supply-chain.ts`, `scripts/check-supply-chain.ts`, `scripts/verify.ts`,
  `package.json`, `bun.lock`, `compose.yaml`, or anything in `infra/containers/`. Report
  needed changes as contract requests.
- Every new third-party image goes in `infra/image-licenses.json` (unit B owns that file;
  unit A requests entries) and is pinned by digest.
- No domain literals (`check-domains`); use `SITE` or the instance env.
- Use the in-repo `scripts/release/manifest.ts` helpers. Do not re-derive versions, image
  refs or asset names.

**Setup in your worktree.** Run `bun install --frozen-lockfile` first. The data services may
or may not be up. You do not need them, except unit B's optional live checks.
