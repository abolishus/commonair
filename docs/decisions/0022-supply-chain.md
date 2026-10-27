<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0022: Supply-chain policy (vet, cool down, pin, audit)

- Status: accepted (2026-10-27; already enforced since 2026-10-22 by AGENTS.md rule 7 and the
  verify gate)
- Date: 2026-10-22

## Context

Registry compromises have become routine: hijacked maintainer accounts publishing malicious
patch releases, worm-style packages that spread through `postinstall`, typosquats, and
retagged container images and GitHub Actions. Most of them are found and pulled within hours
or days. Before this ADR we exact-pinned direct npm dependencies, installed with
`--frozen-lockfile` in CI, and checked licenses (ADR 0002). We did not check for advisories,
had no cooldown on new releases, let bun run install scripts for its built-in list of popular
packages, and referenced actions and images by mutable tags.

## Decisions

1. **Vet before you install.** Every new dependency or upgrade starts with
   `bun scripts/vet-package.ts <name>[@version]`. It fails on a release younger than the
   cooldown, a known vulnerability (OSV), deprecation, or a non-OSI license. It warns on
   install scripts, missing npm provenance, a publisher who did not publish the previous
   version, a package that is under 90 days old, and low download counts. Someone has to read
   each warning and accept it before running the `bun add` it prints.
2. **7-day cooldown.** `bunfig.toml` sets `minimumReleaseAge = 604800`, so bun will not resolve
   any version, transitive ones included, published less than 7 days ago. The same rule applies
   by hand to container tags, Go toolchains and Action releases.
3. **Exact pins everywhere.** Every `package.json` spec, catalog entry and override is an exact
   version, `workspace:` or `catalog:`. No ranges, tags, git URLs or tarballs. `bunfig.toml` sets
   `exact = true`, so `bun add` writes exact pins. `bun.lock` is committed, and CI installs with
   `--frozen-lockfile`. Peer dependency ranges are allowed, because they constrain other code
   and do not resolve anything.
4. **No install scripts by default.** The root `trustedDependencies` is `[]`, which also turns
   off bun's built-in trust list. None of the packages we use needs its script: esbuild and
   msgpackr-extract ship prebuilt binaries as optional dependencies, onnxruntime-node's script
   only downloads GPU providers, and protobufjs's script only checks version schemes. Trusting
   a package requires an entry in `supply-chain.json` `trustedDependencies` that gives the
   reason.
5. **Advisories gate the build.** `scripts/check-supply-chain.ts` runs `bun audit`, and
   `scripts/check-go-vulns.ts` runs govulncheck over the relay. govulncheck is pinned and
   fetched through the Go proxy and checksum database. Both run in `bun run verify`, and CI
   runs verify every night, so a newly published advisory turns `main` red without anyone
   changing code. A Go finding counts only when govulncheck shows the vulnerable function is
   reached. An advisory we cannot fix yet goes into `supply-chain.json` `advisoryExceptions`
   with its id, package, reason (why it cannot be reached or exploited here, and what we are
   waiting for) and an `expires` date. An expired exception fails the gate, and so does one
   that no longer matches any advisory.
6. **Actions are pinned to commit SHAs** with a `# vX.Y.Z` comment. Tags on Actions can be
   moved by whoever controls the repository.
7. **Third-party images are pinned as `name:tag@sha256:<digest>`** everywhere they are pulled:
   compose, Containerfiles, quadlets, Railway config and test helpers. The tag is for people
   and for `infra/image-licenses.json`; the digest is what the engine pulls.
   `bun scripts/pin-images.ts` reports refs that are missing a digest or whose digest has moved,
   and `--write` rewrites them. To bump an image, change the tag, run `--write`, and update the
   license entry. Our own images (`localhost/commonair/*`, `ghcr.io/abolishus/*`) are pinned by
   our release process instead.
8. **A security fix that is still inside the cooldown** may be adopted early, but only from
   the same upstream (the same publisher and repository), only after vetting, and with the
   waiver recorded in the commit message. Waiting the week is the default; skipping it is a
   decision someone signs.

## Consequences

- `bun run verify` now needs network access for `bun audit`, OSV and the Go vulnerability
  database. It fails closed: it refuses rather than skipping.
- Upgrades arrive at least a week after release. Renovate or Dependabot can automate the bumps
  later. Both respect pinned SHAs and digests, and both support a minimum release age.
- Exceptions expire, so each one is reviewed again on a known date instead of being forgotten.
- Not covered yet: CVE scanning of container image contents (for example with Trivy,
  Apache-2.0), and verifying signatures and provenance of npm tarballs and images at install
  time. Both are candidates for a later ADR.
