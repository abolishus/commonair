<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# TLS

Caddy terminates TLS for `PUBLIC_HOSTNAME` on 443 (and HTTP/3 on 443/udp). Where its
certificate comes from is `TLS_MODE` in the env file, which `install --tls` sets:

| `TLS_MODE`       | Certificate                                       | For                                 |
| ---------------- | ------------------------------------------------- | ----------------------------------- |
| `acme` (default) | publicly trusted, from an ACME CA (Let's Encrypt) | any instance on the public internet |
| `internal`       | from Caddy's own CA, which clients must trust     | LAN instances and test hosts        |

The hostname always comes from the env file. No domain is written into the Caddy
configuration. Caddy serves TLS 1.2 and newer.

## ACME

With `TLS_MODE=acme`, Caddy gets a certificate from Let's Encrypt as soon as it starts and
renews it on its own. `ACME_EMAIL` (set by `--email`) receives expiry notices. Without
`ACME_CA`, the issuer is Let's Encrypt only; Caddy does not fall back to another CA.

**Point DNS first.** The CA validates over ports 80 and 443 on the address your A record names.
Create the A record, wait until it resolves from outside, and only then install. Publish an
AAAA record only if the server has a public IPv6 address (the ports listen on it then, and the
CA may validate over IPv6); an AAAA record pointing elsewhere makes validation fail.

**Mind the rate limits.** Let's Encrypt limits failed validations per hostname per hour and
duplicate certificates per week. A server that restarts Caddy in a loop with broken DNS can hit
them and then has to wait. Check DNS and the firewall before you retry, and use the staging CA
while you experiment.

**Staging CA.** To test the setup without touching the production limits, set the ACME
directory to Let's Encrypt's staging CA. Browsers do not trust its certificates, so use it only
until the setup works. In `~/.config/commonair/commonair.env`:

```sh
ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory
```

Apply it with `sh ~/commonair/selfhost.sh install --reinstall`. To switch to the real CA, set
`ACME_CA=` (empty) and reinstall again. Caddy then requests a new certificate from the real CA.

Any other ACME CA works the same way: put its directory URL in `ACME_CA`.

See the certificate's expiry with `sh ~/commonair/selfhost.sh status` (the `cert:` line,
when `openssl` is installed).

## Internal CA

With `--tls internal` (`TLS_MODE=internal`), Caddy issues the certificate from its own CA. No
DNS validation happens, so it works on a LAN, behind NAT, or with a name only your own resolver
knows. Every client (browsers, OBS for WHIP, IRC clients) must trust Caddy's root certificate.

`selfhost.sh status` prints where the root is on the host:

```sh
sh ~/commonair/selfhost.sh status | grep 'root CA'
```

It is `/data/caddy/pki/authorities/local/root.crt` inside the `commonair-caddy-data` volume,
which is this host path:

```sh
echo "$(podman volume inspect commonair-caddy-data --format '{{.Mountpoint}}')/caddy/pki/authorities/local/root.crt"
```

Copy that file to each client and trust it:

```sh
# Debian or Ubuntu
sudo cp root.crt /usr/local/share/ca-certificates/commonair.crt && sudo update-ca-certificates
# Fedora
sudo cp root.crt /etc/pki/ca-trust/source/anchors/commonair.crt && sudo update-ca-trust
# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain root.crt
```

Firefox keeps its own trust store: import the file under Settings → Privacy & Security →
Certificates. The root stays the same across restarts and upgrades as long as the
`commonair-caddy-data` volume exists.

## Uploads and export downloads

Channel images (avatars, banners, panels) and data-export downloads use presigned object
storage URLs on the same host and certificate: `https://<host>/<bucket>/<key>?X-Amz-…`.
`install` sets `S3_PUBLIC_ENDPOINT=https://<host>` and `upgrade` adds it to an older env file,
so there is nothing to configure. With the internal CA, the clients that trust the root for
the site can upload and download too. Caddy forwards only presigned uploads into the media
bucket's `incoming/` prefix (at most 10 MB) and presigned reads of the exports bucket to Garage
(ADR 0024). Every other request on those paths gets the web app's 404, so the rest of Garage
stays private.

An external S3 store is not scripted: the units point `S3_ENDPOINT` at Garage. If you run the
services against one anyway, set `S3_PUBLIC_ENDPOINT` to the store's public endpoint
(`install --reinstall` and `upgrade` keep a value that is not `https://<host>`). The store then
needs a CORS rule that allows `PUT` from `https://<host>` with the `content-type` header, and
the site's Content-Security-Policy needs the store's origin in `connect-src`. The policy lives in
the release's Caddyfile, so that edit does not survive an upgrade.

## The IRC certificate

The IRC gateway serves TLS on 6697 with the same certificate as the web host, so
`IRC_PUBLIC_HOST` equals `PUBLIC_HOSTNAME` (`install` sets both). IRC refuses to start in
production without a certificate.

`commonair-irc-cert.service` copies Caddy's certificate for that host into
`~/.config/commonair/irc-tls/` and restarts IRC when the certificate changed. It is a one-shot
Quadlet unit that runs in the release's `tools` image (no Bun on the host), started by
`commonair-irc-cert.timer` five minutes after boot and then daily. Caddy renews certificates
well before they expire, so the daily copy keeps IRC current.

On a first install with ACME, the install waits a minute for Caddy's certificate. If DNS does
not point at the server yet, there is none: the install finishes without IRC and says so. Once
DNS resolves and Caddy has its certificate, run the sync yourself instead of waiting a day:

```sh
systemctl --user start commonair-irc-cert.service
systemctl --user status commonair-irc.service
```
