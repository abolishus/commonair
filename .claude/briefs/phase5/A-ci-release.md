<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit A: CI and the release workflow

You are implementing unit A of Phase 5 for CommonAir (repo: /Users/joshe/Repos/bcon; you
work in your own git worktree of it). Read AGENTS.md, PLAN.md, docs/architecture.md,
`.claude/briefs/phase5/_common.md` and ADR 0023 first. Do not look outside the repository,
except to resolve upstream Action commit SHAs and tool release checksums (`gh api`,
`git ls-remote`, the projects' GitHub releases).

## You own (write only these)

- `.github/**`, including `ci.yml`, `storybook-pages.yml`, a new `release.yml`, and any
  composite actions under `.github/actions/`
- `scripts/release/**`, except `scripts/release/manifest.ts`
- `scripts/tests/release-*.test.ts`, except `release-manifest.test.ts`

## Contracts you must honor (read-only for you)

- `scripts/release/manifest.ts` and the CLI contracts in `_common.md`. `bundle.ts` and `e2e.ts`
  are written by unit B in parallel, so code against their CLI and do not implement them.
- `compose.yaml` build sections (`x-service-build`, each service's `build.args`) are the source
  of truth for how each image is built.
- `scripts/check-supply-chain.ts` must still pass over your workflows: every `uses:` pinned to
  a full 40-character SHA with a `# vX.Y.Z` comment. The tag must be at least 7 days old.

## Build

1. **CI (`ci.yml`)**. Keep `verify` on pull requests and pushes, and `verify:full` on main
   and the nightly schedule. Fix the current `if` expression too: it mixes `||` and `&&`
   without parentheses.
   - `permissions: {}` at the top, with the minimum per job. Use
     `persist-credentials: false` on checkout.
   - Safe caching only:
     - the Bun install cache, keyed on `bun.lock`;
     - the Go module and build cache, keyed on `relay/go.sum` or `go.mod`;
     - Playwright browsers, keyed on the Playwright version.
       PR caches must never feed the release workflow (cache poisoning). The release workflow
       restores no caches.
   - On failure, upload `harness/reports/**`, any verify logs and podman container logs
     (`podman logs` of every container, collected in a step) as artifacts with a short
     retention.
   - A clear PR signal: one final aggregate job (e.g. `ci-ok`) that branch protection can
     require, plus a job summary of what passed or failed.
   - A `lint-workflows` job runs actionlint and zizmor (pinned version and checksum) over
     `.github/**`, and shellcheck over `scripts/selfhost.sh` and `scripts/selfhost/*.sh`
     when they exist. Fix every zizmor finding at its default persona, or justify any you
     suppress inline.
   - On push to main and nightly, run the **release dry run** (step 2, `dry_run: true`), by
     calling `release.yml` as a reusable workflow. Also run the self-host end-to-end test,
     `bun scripts/selfhost/e2e.ts`, as its own job. It may need rootful podman on the runner,
     or a recent podman from a pinned source; work out what is needed. GitHub's ubuntu-24.04
     has podman 4.9, and the e2e runs Podman 5 inside its own Debian container.
2. **Release workflow (`release.yml`)**. It is triggered by `push: tags: ['v*']`, by
   `workflow_dispatch` (inputs: `tag`, `dry_run` default true, `platforms`), and by
   `workflow_call` (the same inputs) for CI.
   - **prepare**:
     - compute the version with `versionFromTag`; refuse tags that are not semver;
     - generate release notes with `scripts/release/changelog.ts`, from Conventional Commits
       since the previous `v*` tag, grouped by type, with breaking changes first;
     - derive the registry: `ghcr.io/<lowercased github.repository_owner>/commonair` for
       real runs, and an ephemeral local registry for dry runs (below).
   - **images**:
     - a matrix of image × arch on native runners (`ubuntu-24.04` and `ubuntu-24.04-arm`);
     - the matrix comes from `scripts/release/images.ts`, which reads compose.yaml's build
       sections and must cover exactly `RELEASE_IMAGES`, plus relay from
       `relay/Containerfile`; a test enforces that;
     - build with our Containerfiles and the same build args as compose;
     - pass `SOURCE_COMMIT` and version labels and OCI annotations
       (`org.opencontainers.image.source`, `.revision`, `.version`, `.licenses`);
     - push by digest;
     - a merge job creates the multi-arch index per image and tags it with `<version>`
       (plus `latest` for stable releases).
       Pick podman/buildah or docker buildx and justify it in the workflow comment. Both are
       Apache-2.0.
   - **sign & attest** each index digest:
     - `cosign sign` keyless;
     - SBOM with syft (CycloneDX JSON), attached with `cosign attest --type cyclonedx`;
     - SLSA provenance (e.g. `actions/attest-build-provenance` with `push-to-registry: true`,
       or a cosign `slsaprovenance1` attestation), verifiable with
       `cosign verify-attestation` alone.
   - **relay**:
     - `go build` for each of the six `RELAY_TARGETS` with `CGO_ENABLED=0 -trimpath
       -buildvcs=false -ldflags "-s -w -buildid= -X main.version=<version>"`, named with
       `relayAssetName`;
     - a CycloneDX SBOM per binary (cyclonedx-gomod or syft);
     - `cosign sign-blob --bundle <name>.sigstore.json`;
     - provenance as a Sigstore bundle asset.
   - **manifest + bundle**:
     - `scripts/release/write-manifest.ts` assembles `release-manifest.json` from the index
       digests and validates it with `parseManifest`;
     - then call `bun scripts/selfhost/bundle.ts --manifest … --out dist/`;
     - `SHA256SUMS` over every asset, then `cosign sign-blob` over it into
       `SHA256SUMS.sigstore.json`.
   - **publish**: create the GitHub Release (prerelease when `isPrerelease`) with all assets
     and the notes. Use `gh release create` through `env:`, with `contents: write` on this job
     only.
   - **Dry run**:
     - push to a local registry service container, e.g. Zot, instead of ghcr;
     - signing is skipped unless a `sign` input is true;
     - no release is created;
     - upload `dist/` as a workflow artifact.
       It must still build every image for both arches, every binary, SBOMs, the manifest and
       the bundle.
   - Job permissions: start from `permissions: {}`. Grant per job only `contents: read`,
     `contents: write` (publish), `packages: write` and `id-token: write` (push/sign), and
     `attestations: write` (if you use GitHub attestations).
   - `concurrency` keyed on the tag. `timeout-minutes` on every job.
3. **Scripts (`scripts/release/`, Bun, typed, unit-tested)**:
   - `changelog.ts`: parse `git log` between two refs; group by `feat`, `fix`, `perf`,
     `refactor`, `docs`, `build`, `ci`, `test` and `chore`; `!` and `BREAKING CHANGE:` go
     first; scopes are kept; DCO trailers are ignored. Pure core function plus a thin CLI.
   - `images.ts`: the build matrix from compose.yaml.
   - `write-manifest.ts`: digests in, validated manifest out.
   - `checksums.ts` if it is easier than `sha256sum`.
     Put every bit of logic in tested TypeScript, not in workflow shell.
4. **Local validation you run yourself**:
   - actionlint and zizmor over `.github/**` (install pinned versions via `go install` or
     pipx into a scratch dir; both are MIT);
   - `bun scripts/check-supply-chain.ts`, if it can run offline; otherwise say so;
   - a local dry-run build of one service image for linux/arm64 with the exact build command
     the workflow uses (`podman build …`), to prove the command line;
   - `go build` of all six relay targets, using the workflow's flags, into a scratch dir.

## Tests you must add

`scripts/tests/release-changelog.test.ts`:

- grouping and ordering;
- breaking changes, by `!` and by footer;
- a scope;
- non-conventional subjects go into "Other";
- an empty range;
- DCO trailers and the Co-Authored-By trailer are ignored.

`scripts/tests/release-images.test.ts`:

- the matrix equals `RELEASE_IMAGES`;
- the build args match compose;
- the relay is included.

`scripts/tests/release-write-manifest.test.ts`:

- a valid manifest is written;
- a missing digest fails;
- a bad digest fails;
- a tag/version mismatch fails.

## Done means

See `.claude/briefs/_done-means.md`, plus:

- actionlint and zizmor are clean (paste their output summary);
- `bun --bun vp test run` passes in `scripts/` (with counts);
- `bunx tsc -p scripts --noEmit` passes;
- `vp lint --deny-warnings` and `vp fmt --check` pass on your paths.

In your report, list:

- every Action and tool you pinned (name, version, SHA or checksum, license);
- every image you need added to `infra/image-licenses.json` (a contract request with
  name:tag@digest and license);
- the exact `gh workflow run` commands for a dry run and for a fork release.
