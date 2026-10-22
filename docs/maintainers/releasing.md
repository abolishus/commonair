<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Releasing

How maintainers cut a CommonAir release. The decisions behind it are in
[ADR 0023](../decisions/0023-release-and-self-hosting.md); the workflow is
`.github/workflows/release.yml`, and every logic step in it is a tested script in
`scripts/release/`.

A release is a `vMAJOR.MINOR.PATCH[-pre]` tag. Pushing it builds and publishes:

- the 14 images (`RELEASE_IMAGES` in `scripts/release/manifest.ts`) for linux/amd64 and
  linux/arm64 on native runners, pushed by digest to `ghcr.io/<owner>/commonair/<image>` as
  multi-arch indexes tagged `<version>`, each signed with cosign and carrying CycloneDX SBOM and
  SLSA provenance attestations;
- the relay binaries for six targets, each with an SBOM, a signature bundle and signed
  provenance;
- `release-manifest.json`, the self-host bundle `commonair-selfhost_<version>.tar.gz`, and a
  signed `SHA256SUMS`;
- the GitHub Release with notes generated from Conventional Commits.

Asset names come from `scripts/release/manifest.ts` and `scripts/release/assets.ts`.
[docs/self-hosting/verifying.md](../self-hosting/verifying.md) lists them for operators.

The jobs run in this order: `prepare` → `build` (one job per image and architecture) →
`publish-image` (per image) and `relay` → `manifest` (manifest, bundle, checksums, signature) →
`publish` (`gh release create`, only after everything else succeeded) → `latest` (stable
releases only).

## Prerequisites

Once per repository:

- **Branch protection on `main` requires the `ci-ok` check.** `ci-ok` aggregates every CI job
  (lint-workflows, verify, and on pushes to main the release dry run and the self-host
  end-to-end test), so it is the one required check.
- **Tag protection** (a ruleset on `v*` tags) so only maintainers can create release tags. The
  signing identity is "this repository's `release.yml` at a `v*` tag", so whoever can push such
  a tag can publish a signed release.
- **arm64 runners.** Builds use GitHub's `ubuntu-24.04-arm` runners (free for public
  repositories). arm64 is required at launch (ADR 0023). A fork without them can release amd64
  only, by running the workflow by hand with `-f platforms=linux/amd64`.
- **Actions may create releases.** The `publish` job uses the workflow's `GITHUB_TOKEN` with
  `contents: write`; the repository's Actions settings must allow that.

Once after the first real release:

- **Make every package public.** GitHub creates each new ghcr.io package private, so nobody can
  pull the images until you change that. For each of the 14 packages under
  `ghcr.io/<owner>/commonair/`: the package's settings → Danger Zone → Change visibility →
  Public. Check from a machine that is not logged in:

  ```sh
  podman pull ghcr.io/abolishus/commonair/api:0.1.0-rc.1
  ```

  New packages only appear when an image is added to `RELEASE_IMAGES`; repeat this for those.

## Cutting `v0.1.0-rc.1`

1. **Main is green.** The last `ci` run on `main` passed, including `release dry run` and both
   `self-host e2e` jobs (they run on pushes to main and nightly).

   ```sh
   gh run list --workflow ci.yml --branch main --limit 3
   ```

2. **Preview the release notes** for the commit you will tag:

   ```sh
   bun scripts/release/changelog.ts --to HEAD --version 0.1.0-rc.1
   ```

3. **Tag and push** an annotated tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -a v0.1.0-rc.1 -m "v0.1.0-rc.1"
   git push origin v0.1.0-rc.1
   ```

4. **Watch the run.** About 30 build jobs, then publishing:

   ```sh
   gh run list --workflow release.yml --limit 1
   gh run watch <run-id>
   ```

A tag with a prerelease part (`-rc.1`) makes a GitHub prerelease and does not move `latest`.

### A manual real release

`workflow_dispatch` can publish too, but only from the tag itself: keyless certificates name the
ref the workflow ran from, and a run from a branch would sign with an identity operators'
verification rejects. `prepare.ts` refuses it with the right command:

```sh
gh workflow run release.yml --ref v0.1.0-rc.1 -f tag=v0.1.0-rc.1 -f dry_run=false
```

## Dry runs

A dry run builds every artifact, pushes the images to a throwaway Zot registry on the runner,
signs only when asked, creates no release, and uploads `dist/` as the `release-dist` workflow
artifact. CI runs one on every push to main and nightly.

Run one by hand (from any branch; no tag needed):

```sh
gh workflow run release.yml --ref my-branch -f dry_run=true
gh workflow run release.yml --ref my-branch -f dry_run=true -f sign=true   # also exercise signing
gh run download <run-id> -n release-dist
```

Without a tag, a dry run versions itself `0.0.0-dryrun.<run number>`. With `-f tag=…` it uses
that version. On a fork, the same works with the fork's own runners; add
`-f platforms=linux/amd64` if the fork has no arm64 runners.

To test the bundle on a host before tagging, `bun scripts/selfhost/e2e.ts` builds all images
locally, installs, upgrades and rolls back on a Debian 13 (or `--distro fedora`) container;
see its header for requirements.

## Verifying the published release yourself

Before announcing it, check the release the way an operator would, from a machine that is not
logged in to GitHub, following [verifying.md](../self-hosting/verifying.md):

1. `cosign verify-blob` on `SHA256SUMS`, then `sha256sum --check` on every asset.
2. `cosign verify` and both `cosign verify-attestation` types on every image in
   `release-manifest.json`.
3. `cosign verify-blob` on one relay binary.
4. Install it on a scratch VM with `--tls internal`
   ([install.md](../self-hosting/install.md)), and upgrade an existing scratch instance from the
   previous release.

## Promoting an rc to stable

There is no promotion of artifacts: a stable release is a new tag, built and signed from
scratch. When an rc has been tested and nothing needs to change, tag the same commit:

```sh
git tag -a v0.1.0 -m "v0.1.0" v0.1.0-rc.2^{commit}
git push origin v0.1.0
```

The images are rebuilt and signed under the stable tag. Their labels carry the version, so their
digests differ from the rc's. `latest` moves to them after the GitHub Release exists.

The notes list commits since the nearest earlier `v*` tag, which is the last rc, so a stable
release's generated notes are short. Replace them with the full notes since the previous stable
release, for example for `v0.2.0`:

```sh
bun scripts/release/changelog.ts --from v0.1.0 --to v0.2.0 --version 0.2.0 \
  --repo https://github.com/abolishus/commonair --out notes.md
gh release edit v0.2.0 --notes-file notes.md
```

For the first stable release, `v0.1.0`, omitting `--from` is not enough: it defaults to the
nearest earlier `v*` tag, which is the last rc. Pass an empty `--from` to include all history:

```sh
bun scripts/release/changelog.ts --from '' --to v0.1.0 --version 0.1.0 \
  --repo https://github.com/abolishus/commonair --out notes.md
```

## The changelog

Release notes are generated by `scripts/release/changelog.ts` from Conventional Commit subjects
between the previous `v*` tag and the release commit. Breaking changes (`type!:` or a
`BREAKING CHANGE:` footer) come first, then features, fixes, performance, refactoring, docs,
build, CI, tests and chores; anything else lands under "Other". Trailers never appear.

So the changelog is only as good as the commit messages. Write subjects for operators, and
always mark breaking changes, including any migration that is not additive (ADR 0023 §9 forbids
those between adjacent releases).

There are two records, built from the same script:

- **GitHub Release notes**, one per tag, rcs included. `release.yml` generates them with
  `--to <tag commit>` and the default `--from`, so they cover the commits since the nearest
  earlier `v*` tag. For a stable release, replace them with the full notes since the previous
  stable release ([Promoting an rc to stable](#promoting-an-rc-to-stable)). Edit a release's
  notes with `gh release edit <tag> --notes-file <file>`.
- **`CHANGELOG.md`** in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, one
  section per stable release. Prereleases get no section of their own. Changes worth an
  operator's attention that commit subjects do not convey can be written by hand under
  `## [Unreleased]` as they land, under Keep a Changelog headings (`### Added`, `### Changed`,
  …).

Update `CHANGELOG.md` on `main` once the stable release is published, not before tagging: the
stable tag goes on the rc's commit, which must not change. For `v0.2.0`, using the `notes.md`
generated above (`--from v0.1.0`, or `--from ''` for `v0.1.0`):

1. Rename `## [Unreleased]` to `## [0.2.0] - YYYY-MM-DD`, with the date the stable tag was
   pushed (UTC), and add a new, empty `## [Unreleased]` above it.
2. Under the new version's heading, after any hand-written entries, paste `notes.md` without its
   first line (`Changes in 0.2.0, since v0.1.0.`). Its `### Breaking changes`, `### Features`,
   … headings sit at the same level as the hand-written ones. If a hand-written entry and a
   generated line say the same thing, keep one.
3. Update the link references at the bottom:

   ```markdown
   [Unreleased]: https://github.com/abolishus/commonair/compare/v0.2.0...HEAD
   [0.2.0]: https://github.com/abolishus/commonair/compare/v0.1.0...v0.2.0
   ```

   For the first release, link `[0.1.0]` to `https://github.com/abolishus/commonair/releases/tag/v0.1.0`.

4. Commit it as `docs(changelog): release 0.2.0` and push `main`.

## Yanking a bad release

Never delete or move a published tag: its signatures are in the public Rekor log, and operators
may already run it.

1. **Stop new installs.** Turn the release into a draft, which hides it and its assets, so
   `selfhost.sh --version` can no longer download it:

   ```sh
   gh release edit v0.1.1 --draft
   ```

2. **Fix forward.** Cut the next patch release (`v0.1.2`) with the fix, and say in its notes
   what was wrong with the yanked one and whether operators who installed it must act.
3. **If `latest` moved to the bad release**, point it back at the previous stable release's
   images. Nothing pulls `latest` (units pin digests), so this matters only for people browsing
   the registry. With crane (Apache-2.0), using digests from the good release's
   `release-manifest.json`:

   ```sh
   crane tag ghcr.io/abolishus/commonair/api@sha256:<digest> latest
   ```

4. **Tell operators** through the project's usual channels. Operators on the bad release run
   `selfhost.sh upgrade --version v0.1.2`.

## When something fails

Nothing is published to the GitHub Release until every job before `publish` has passed, so a
failed run leaves no release behind. Images may already be in the registry under the version
tag; that is harmless, because nothing installs without the release's manifest.

- **One build job fails** (a flaky download, a runner problem). `fail-fast` cancels the other
  builds. Re-run the failed jobs: `gh run rerun <run-id> --failed`.
- **An arm64 build fails or never gets a runner.** Re-run it. If arm64 runners are unavailable
  for a long time, a release without arm64 needs a maintainers' decision (it deviates from ADR
  0023); it is then a manual run from the tag with `-f platforms=linux/amd64`.
- **Signing or attesting fails** (`cosign sign`, `attest`, `sign-blob`). Usually a Sigstore
  outage (Fulcio or Rekor) or a missing `id-token: write` permission. Check
  [Sigstore's status page](https://status.sigstore.dev), wait, and re-run the failed jobs. The
  re-run signs the same digests, because it reuses the build artifacts.
- **The `manifest` job reports missing or unexpected assets.** `assemble.ts` checks the exact
  asset set. A missing asset means an earlier job uploaded less than expected; re-run from that
  job. An unexpected one means the expected set (`expectedAssets` in
  `scripts/release/assemble.ts`) and the jobs disagree; fix that on `main` and cut the next rc.
- **`publish` fails** (`gh release create`). Re-run it. If the release was created but an
  asset upload failed, delete the release first (`gh release delete <tag>`, which keeps the
  tag), then re-run.
- **The release itself is wrong** after publishing: yank it (above) and fix forward. Never
  re-run a published release to overwrite its assets.
