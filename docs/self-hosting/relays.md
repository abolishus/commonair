<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Running a member relay

A member relay is a small, single-binary segment cache. A co-op member runs one to donate
upload bandwidth: the instance sends some viewers to it, it pulls each live segment from the
origin once and serves it to them, and it submits a signed receipt of the bytes it delivered
every minute. Verified receipts count toward the member's patronage.

The relay does not run on the instance's server. It runs anywhere with a public HTTPS address
and spare upload bandwidth. Its flags and behavior are documented in
[relay/README.md](../../relay/README.md).

Every release ships the relay two ways:

- **binaries** `commonair-relay_<version>_<os>_<arch>` for Linux, macOS and Windows (`.exe`),
  on amd64 and arm64, each with a CycloneDX SBOM (`.cdx.json`), a signature bundle
  (`.sigstore.json`) and signed SLSA provenance (`.intoto.sigstore.json`);
- **an image**, `relay`, in the release registry (`ghcr.io/abolishus/commonair/relay`), signed
  like every release image.

## 1. Get a registration token

Sign in to the instance and open **Relays** (`https://stream.example.org/relays`). Create a
relay and copy the token (`relay_…`). It is shown once.

## 2. Get the relay and verify it

### Binary

```sh
VERSION=0.1.0-rc.1
BIN=commonair-relay_${VERSION}_linux_amd64
BASE=https://github.com/abolishus/commonair/releases/download/v$VERSION
curl -fsSLO "$BASE/$BIN"
curl -fsSLO "$BASE/$BIN.sigstore.json"
curl -fsSLO "$BASE/SHA256SUMS"
curl -fsSLO "$BASE/SHA256SUMS.sigstore.json"
```

Check it with cosign (identity flags as in [verifying.md](verifying.md#the-identity)):

```sh
cosign verify-blob --bundle "$BIN.sigstore.json" \
  --certificate-identity-regexp '^https://github\.com/abolishus/commonair/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$BIN"
```

Or, without cosign for the binary itself, verify `SHA256SUMS` once
([install.md](install.md#2-download-and-verify-the-release)) and then:

```sh
sha256sum --check --ignore-missing SHA256SUMS
install -m 755 "$BIN" /usr/local/bin/commonair-relay
```

### Image

Take the exact reference from the release's `release-manifest.json`, which pins each image by
digest:

```sh
curl -fsSLO "$BASE/release-manifest.json"
RELAY_IMAGE=$(jq -r '"\(.registry)/relay:\(.version)@\(.images.relay.digest)"' release-manifest.json)
```

Verify `release-manifest.json` against `SHA256SUMS` like any other asset, and the image itself
with `cosign verify` ([verifying.md](verifying.md#images)).

## 3. Run it

The relay needs a public HTTPS URL: either its own certificate (`--tls-cert`, `--tls-key`) or a
TLS-terminating proxy in front of it (`--behind-proxy`). The token goes in the environment, not
on the command line, so it stays out of `ps` and shell history. Never type it into a command:
read it without echo (paste it at the prompt), or keep it in a file only you can read.

```sh
read -rs COMMONAIR_RELAY_TOKEN && export COMMONAIR_RELAY_TOKEN
commonair-relay \
  --api https://stream.example.org/ \
  --public-url https://relay.example.org \
  --listen :8443 \
  --capacity-mbps 200 \
  --data-dir ~/.commonair-relay \
  --tls-cert /etc/letsencrypt/live/relay.example.org/fullchain.pem \
  --tls-key /etc/letsencrypt/live/relay.example.org/privkey.pem
```

With Podman, behind a proxy, keep the token in a Podman secret. `podman inspect` and `ps` then
show only the secret's name:

```sh
read -rs COMMONAIR_RELAY_TOKEN
printf %s "$COMMONAIR_RELAY_TOKEN" | podman secret create commonair-relay-token -
unset COMMONAIR_RELAY_TOKEN
podman run -d --name commonair-relay --restart=always --stop-timeout 50 \
  -p 8443:8443 \
  -v commonair-relay:/data \
  --secret commonair-relay-token,type=env,target=COMMONAIR_RELAY_TOKEN \
  "$RELAY_IMAGE" \
  --api https://stream.example.org/ --public-url https://relay.example.org \
  --capacity-mbps 200 --behind-proxy
```

Keep the data directory (or the `/data` volume): it holds the relay's key, which is its
identity, and receipts not sent yet. `--stop-timeout 50` gives it time to drain and send its
final receipt.

Within a minute the relay shows as `active` on the Relays page. If it does not, its first log
lines say why: an unreachable public URL (the instance checks it), a refused token, or a
private address the instance does not accept.

## Upgrading

Download and verify the new release's binary or image the same way, stop the relay, swap it,
and start it again with the same data directory. The relay registers again with the same key.
