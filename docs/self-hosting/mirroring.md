<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Mirroring a release

Releases publish images to `ghcr.io`. To depend on no registry you do not run, copy a release
into your own and install from there. `cosign copy` keeps digests, signatures and attestations,
so the units, the release manifest and [signature verification](verifying.md) work unchanged
against the mirror ([ADR 0023 §2](../decisions/0023-release-and-self-hosting.md)).

## 1. Run a registry

Any OCI registry works. Two FOSS options:

- [Zot](https://zotregistry.dev) (Apache-2.0), which the project's own CI uses;
- [CNCF Distribution](https://distribution.github.io/distribution/) (Apache-2.0), the
  `registry` image.

A minimal Zot on a host of your own, pinned by digest like every image the project uses:

```sh
podman run -d --name zot --restart=always -p 5000:5000 -v zot-data:/var/lib/registry \
  ghcr.io/project-zot/zot:v2.1.22@sha256:96cda11459ce6f8c60da3b03f03e9f67fd11b3ae2d82c4c04c92b3c608996080
```

Serve it over HTTPS (behind Caddy or another TLS proxy) and require authentication for pushes;
see Zot's documentation. Podman refuses plain HTTP registries unless you list them as
`insecure` in `/etc/containers/registries.conf`, which is acceptable only on a private network.

The examples use `registry.example.org/commonair` as the mirror's namespace.

## 2. Copy a release

Download and [verify](verifying.md#release-assets) the release's `release-manifest.json`, log
in to the mirror (`cosign login registry.example.org` or `podman login`), and copy each image by
digest:

```sh
MIRROR=registry.example.org/commonair
VERSION=$(jq -r .version release-manifest.json)
SOURCE=$(jq -r .registry release-manifest.json)
jq -r '.images | to_entries[] | "\(.key) \(.value.digest)"' release-manifest.json |
  while read -r name digest; do
    cosign copy "$SOURCE/$name@$digest" "$MIRROR/$name:$VERSION"
  done
```

`cosign copy` copies the whole multi-arch index, both platforms, and the signatures and
attestations attached to it. Then check the mirror the same way you would check ghcr.io:

```sh
jq -r --arg m "$MIRROR" '.version as $v | .images | to_entries[] | "\($m)/\(.key):\($v)@\(.value.digest)"' \
  release-manifest.json | while read -r ref; do
    cosign verify "${ID[@]}" "$ref" > /dev/null && echo "signed: $ref"
  done
```

(`ID` holds the identity flags from [verifying.md](verifying.md#the-identity).)

## 3. Install from the mirror

```sh
sh "commonair-selfhost_$VERSION/selfhost.sh" install --yes \
  --bundle "$PWD/commonair-selfhost_$VERSION.tar.gz" \
  --domain stream.example.org --email ops@example.org \
  --registry registry.example.org/commonair
```

`--registry` rewrites our 14 images in the units to the mirror, with the same digests. It is
recorded in `~/.config/commonair/selfhost.conf`, so every later `upgrade` and
`install --reinstall` pulls from the mirror too. Copy each new release into the mirror before
you upgrade.

`--registry` covers only the project's own images. The six third-party images (Caddy, Garage,
MediaMTX, Valkey, Prometheus, Grafana) still come from `docker.io`, `ghcr.io` and `quay.io`,
pinned by digest. To mirror them as well, copy them the same way and configure a registry mirror
for those hosts in `/etc/containers/registries.conf`:

```toml
[[registry]]
location = "docker.io"

[[registry.mirror]]
location = "registry.example.org/docker.io"
```

Podman then tries the mirror first for by-digest pulls, and the digest pin guarantees the same
bytes.
