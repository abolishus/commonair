<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Verifying a release

Every release artifact is signed keylessly with [cosign](https://github.com/sigstore/cosign)
by the project's release workflow, through GitHub Actions OIDC, Sigstore's Fulcio CA and the
public Rekor log ([ADR 0023](../decisions/0023-release-and-self-hosting.md)). There is no
long-lived key to trust. You check that an artifact was signed by **the release workflow of this
repository, running for a version tag**, and you need only the cosign CLI (3.x) to do it, not
GitHub's API.

## What a release contains

| Asset                                                   | What it is                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `commonair-selfhost_<version>.tar.gz`                   | The self-host bundle: `selfhost.sh`, rendered units, config       |
| `release-manifest.json`                                 | The version, commit, registry and the digest of every image       |
| `commonair-relay_<version>_<os>_<arch>[.exe]`           | Relay binaries                                                    |
| `<relay binary>.cdx.json`                               | CycloneDX SBOM of a relay binary                                  |
| `<relay binary>.sigstore.json`                          | cosign signature bundle of a relay binary                         |
| `<relay binary>.intoto.sigstore.json`                   | Signed SLSA provenance of a relay binary                          |
| `<relay binary>.intoto.jsonl`                           | The same signed provenance as a bare DSSE envelope (SLSA layout)  |
| `<relay binary>.provenance.json`                        | The same provenance, unsigned, for reading                        |
| `commonair-image-<name>_<version>_<os>_<arch>.cdx.json` | SBOM of one image, one platform                                   |
| `commonair-image-<name>_<version>.provenance.json`      | SLSA provenance predicate of one image (signed copy on the image) |
| `SHA256SUMS`                                            | SHA-256 of every asset above                                      |
| `SHA256SUMS.sigstore.json`                              | cosign signature bundle of `SHA256SUMS`                           |

The images themselves are in the registry, `ghcr.io/abolishus/commonair/<name>`, as multi-arch
indexes for linux/amd64 and linux/arm64. Each is signed (the index and every platform
manifest), with its SBOMs and provenance attached as signed attestations.

## The identity

Every command below takes the same two flags. For this repository:

```sh
--certificate-identity-regexp '^https://github\.com/abolishus/commonair/\.github/workflows/release\.yml@refs/tags/v'
--certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The regular expression accepts any version tag of this repository's `release.yml`, and nothing
else: not another workflow, not a branch, not a fork. For a fork, replace `abolishus/commonair`
with the fork's owner and name. To pin one exact release, use
`--certificate-identity https://github.com/abolishus/commonair/.github/workflows/release.yml@refs/tags/v0.1.0`
instead of the regular expression.

The examples set them once:

```sh
ID=(--certificate-identity-regexp '^https://github\.com/abolishus/commonair/\.github/workflows/release\.yml@refs/tags/v'
    --certificate-oidc-issuer https://token.actions.githubusercontent.com)
```

That is bash or zsh array syntax. In POSIX `sh`, write the flags out.

## Release assets

Verify `SHA256SUMS` once, then every asset against it:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json "${ID[@]}" SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

A relay binary also has its own signature and provenance:

```sh
BIN=commonair-relay_0.1.0_linux_amd64
cosign verify-blob --bundle "$BIN.sigstore.json" "${ID[@]}" "$BIN"
cosign verify-blob-attestation --bundle "$BIN.intoto.sigstore.json" --type slsaprovenance1 "${ID[@]}" "$BIN"
```

## Images

Take the references from a verified `release-manifest.json`, so you check exactly the digests
the release pinned:

```sh
jq -r '.registry as $r | .version as $v | .images | to_entries[] | "\($r)/\(.key):\($v)@\(.value.digest)"' \
  release-manifest.json > images.txt
```

Then, for each image:

```sh
while read -r ref; do
  cosign verify "${ID[@]}" "$ref" > /dev/null && echo "signed: $ref"
done < images.txt
```

The SBOM and provenance attestations:

```sh
REF=$(grep '/api:' images.txt)
cosign verify-attestation --type cyclonedx "${ID[@]}" "$REF" > /dev/null
cosign verify-attestation --type slsaprovenance1 "${ID[@]}" "$REF" > /dev/null
```

The index carries one CycloneDX attestation per platform. `selfhost.sh` pulls exactly these
digests, so a verified manifest means verified images on your server.

## Reading an SBOM

The SBOMs are CycloneDX JSON. The release assets are the easiest to read: list every component
with its version and license.

```sh
jq -r '.components[] | [.name, .version, ((.licenses // [])[0].license | (.id // .name)) // "?"] | @tsv' \
  commonair-image-api_0.1.0_linux_amd64.cdx.json | sort | column -t
```

The same documents are attached to the images. `cosign verify-attestation` prints each verified
attestation as a DSSE envelope; the SBOM is the `predicate` inside its base64 `payload`:

```sh
cosign verify-attestation --type cyclonedx "${ID[@]}" "$REF" \
  | jq -r '.payload' | base64 -d | jq '.predicate.components | length'
```

## Provenance

The SLSA provenance names the source repository and commit, the workflow and the run that built
the artifact. Read an image's from the release asset:

```sh
jq '{repo: .buildDefinition.externalParameters.workflow.repository,
     ref: .buildDefinition.externalParameters.workflow.ref,
     commit: .buildDefinition.resolvedDependencies[0].digest.gitCommit,
     run: .runDetails.metadata.invocationId}' \
  commonair-image-api_0.1.0.provenance.json
```

The commit must be the one the release's tag points at. With a clone of the repository:
`git rev-parse v0.1.0^{commit}`.
