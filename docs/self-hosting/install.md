<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Install

The examples use `stream.example.org` for the instance and `ops@example.org` for the operator.
Replace both, and replace `0.1.0-rc.1` with the latest release.

## 1. Prepare the server

Install Debian 13 or Fedora 42+ and update it. Then, as root:

```sh
apt-get update && apt-get full-upgrade -y     # Debian
dnf upgrade -y                                # Fedora
```

Point the A record for your hostname at the server ([requirements.md](requirements.md#dns)),
and open the [ports](requirements.md#ports) in any firewall in front of it.

Install [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3.x, so you and
`selfhost.sh` can check the release's signature. The release workflow signs with cosign 3.1.3.
Without cosign, `selfhost.sh` still checks every download against `SHA256SUMS`, but nothing
proves that `SHA256SUMS` itself came from the project.

You do not need to install Podman or create a user. `selfhost.sh` does that when you run it as
root.

## 2. Download and verify the release

Never pipe a download into a shell. Download the bundle, its checksums and their signature,
check them, and only then run anything:

```sh
VERSION=0.1.0-rc.1
BASE=https://github.com/abolishus/commonair/releases/download/v$VERSION
mkdir -p ~/commonair-release && cd ~/commonair-release
curl -fsSLO "$BASE/SHA256SUMS"
curl -fsSLO "$BASE/SHA256SUMS.sigstore.json"
curl -fsSLO "$BASE/commonair-selfhost_$VERSION.tar.gz"
```

Check that the release workflow of this repository signed `SHA256SUMS`, for a version tag:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/abolishus/commonair/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

Then check the bundle against it and unpack it:

```sh
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf "commonair-selfhost_$VERSION.tar.gz"
```

`--ignore-missing` skips the assets you did not download. The line for
`commonair-selfhost_<version>.tar.gz` must say `OK`. [verifying.md](verifying.md) covers the
images, SBOMs and provenance.

## 3. Install

As root, in the same directory:

```sh
sh "commonair-selfhost_$VERSION/selfhost.sh" install --yes \
  --bundle "$PWD/commonair-selfhost_$VERSION.tar.gz" \
  --domain stream.example.org \
  --email ops@example.org \
  --require-signature
```

- `--yes` is your consent to prepare the host as root. Without it, `selfhost.sh` refuses to run
  as root.
- `--bundle` installs the bundle you just verified. `selfhost.sh` checks it again against the
  `SHA256SUMS` next to it, and checks the signature of `SHA256SUMS` when cosign is installed.
- `--require-signature` makes that signature check mandatory: the install fails if cosign is
  missing or the signature does not verify.
- `--email` is the ACME account address and the default for every instance contact (security,
  abuse, DMCA, privacy). Change the contacts later in the env file.

Instead of `--bundle`, `--version v0.1.0-rc.1` downloads the release itself over HTTPS and runs
the same checks. Other options:

| Option                 | What it does                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `--tls internal`       | Caddy's own CA instead of ACME, for LAN and test hosts ([tls.md](tls.md))               |
| `--public-ip <a,b>`    | Addresses WHIP clients reach the server on, if not its interface addresses (behind NAT) |
| `--registry <host/ns>` | Pull our images from your mirror ([mirroring.md](mirroring.md))                         |
| `--model <path>`       | A local copy of the moderation model, checked against its pinned sha256                 |
| `--unsupported-distro` | Continue on a distribution other than Debian 13 or Fedora 42+                           |
| `--reinstall`          | Install over an existing instance (secrets and env-file edits are kept)                 |

Run `sh selfhost.sh --help` for the full list.

A fork's releases: set `COMMONAIR_REPOSITORY_URL=https://…` (the fork's repository URL) in the
environment of every `selfhost.sh` run. It decides where releases are downloaded from and which
workflow identity their signature must carry.

## 4. What it checks and writes

### As root (host preparation)

1. Refuses anything but Debian 13 or Fedora 42+ (unless `--unsupported-distro`).
2. Installs Podman, catatonit and their helpers if they are missing.
3. Creates the `commonair` user (with `/etc/subuid` and `/etc/subgid` ranges) if it does not
   exist.
4. Enables linger for `commonair`, so its units keep running without a login.
5. Writes `net.ipv4.ip_unprivileged_port_start=80` to `/etc/sysctl.d/90-commonair.conf` and
   applies it.
6. Copies the script and the bundle into a fresh root-owned directory under `/var/tmp`, and runs
   the rest as `commonair`.

### As the service user

Checks, each failing with the fix to apply:

- the distribution, Podman 5 and catatonit, systemd 254+ and a running user manager;
- subuid and subgid entries, linger, and the unprivileged-port sysctl;
- on a first install, that nothing listens on 80, 443, 1935, 6667, 6697 (TCP) or 443, 8189
  (UDP). It prints the firewall command when firewalld is running, and whether the host has a
  global IPv6 address (the public ports listen on it too, so an AAAA record can point here).

Then it:

1. verifies and unpacks the release into `~/.local/share/commonair/releases/<version>/`;
2. pulls every image by digest;
3. writes `~/.config/commonair/commonair.env` (mode 0600, in a 0700 directory) with fresh
   secrets, generated in the release's `tools` image and never printed;
4. sets the public URLs from `--domain`, `NODE_ENV=production`, `TLS_MODE`, the contacts from
   `--email`, and `MTX_WEBRTCADDITIONALHOSTS` from `--public-ip` or the server's global
   addresses;
5. creates the Podman secrets `commonair-database-url`, `commonair-owner-database-url` and
   `commonair-grafana-admin-password` from the env file;
6. points the symlink `~/commonair` at the release, and records a `--registry` mirror in
   `~/.config/commonair/selfhost.conf`;
7. creates the moderation hash lists `~/.local/share/commonair/moderation/csam.pdq` and
   `ncii.pdq` (empty, with a warning) and downloads the moderation model to
   `~/.local/share/commonair/models/`, checked against its pinned sha256;
8. copies the Quadlet units to `~/.config/containers/systemd/` and the timers to
   `~/.config/systemd/user/`;
9. runs the database migrations to completion, starts every service, enables the backup and
   IRC certificate timers, and waits until every service is healthy (up to 15 minutes);
10. copies Caddy's certificate to IRC. Without DNS yet, there is no certificate; the install
    finishes without IRC and the daily timer retries ([tls.md](tls.md#the-irc-certificate)).

It ends with the instance URL and the next steps. The empty hash lists mean known-image matching
(CSAM, NCII) is off until you install lists; see
[the trust and safety guide](../operators/trust-safety.md).

Keep an offline copy of `~/.config/commonair/commonair.env`. It holds every secret, including
the evidence private key, without which sealed evidence cannot be read, and you need it to
restore onto a new server ([backups.md](backups.md)).

## 5. The first admin account

Do the rest as `commonair`. Give it your SSH key first, as root:

```sh
install -d -m 700 -o commonair -g commonair /home/commonair/.ssh
install -m 600 -o commonair -g commonair ~/.ssh/authorized_keys /home/commonair/.ssh/
```

Then `ssh commonair@stream.example.org`.

**Set up mail.** Sign-up requires a verified email address. Edit
`~/.config/commonair/commonair.env`:

```sh
SMTP_HOST=smtp.example.org
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=…
SMTP_PASSWORD=…
MAIL_FROM=noreply@stream.example.org
```

`SMTP_REQUIRE_TLS=true` refuses to send without STARTTLS. For implicit TLS on port 465, set
`SMTP_PORT=465` and `SMTP_SECURE=true` instead. The env file takes one `KEY=value` per line,
with no quotes and no comments after a value.

Review the contacts there too (`CONTACT_EMAIL`, `SECURITY_EMAIL`, `ABUSE_EMAIL`, `DMCA_EMAIL`,
`PRIVACY_EMAIL`, all set to `--email`), and `INSTANCE_NAME`. Apply the edits:

```sh
sh ~/commonair/selfhost.sh install --reinstall
```

`install --reinstall` without `--version` or `--bundle` reuses the installed release. It keeps
every secret and every edit, and restarts the stack in the right order.

**Sign up** at `https://stream.example.org/signup` and confirm the email.

**Make that account an admin.** The role CLI runs in the release's `tools` image, as the
database owner, and writes an audit-log entry:

```sh
TOOLS=$(sed -n 's/^Image=//p' ~/commonair/quadlet/commonair-migrate.container)
podman run --rm --network commonair \
  --secret commonair-owner-database-url,type=env,target=DATABASE_URL \
  "$TOOLS" bun packages/db/src/roles/cli.ts yourname admin
```

Sign out and in again to pick up the role. The same command grants `treasurer` (needed for the
manual payments adapter) and the other roles; after the first admin, admins change roles in the
web app.

## 6. First stream

Open `https://stream.example.org/dashboard` and create a stream key. It looks like
`<channel>?key=<secret>`.

**OBS over RTMP.** Settings → Stream:

- Service: Custom…
- Server: `rtmp://stream.example.org/live`
- Stream Key: the whole key from the dashboard

**OBS over WHIP** (OBS 30 or newer). Settings → Stream:

- Service: WHIP
- Server: `https://stream.example.org/live/<channel>/whip`
- Bearer Token: the part of the key after `?key=`

WHIP needs UDP 8189 open and `MTX_WEBRTCADDITIONALHOSTS` set to the address encoders reach the
server on ([troubleshooting.md](troubleshooting.md#whip-connects-but-no-video-arrives)).

Start streaming and open `https://stream.example.org/<channel>` in a browser. Video should play
within a few seconds.

Without OBS, a test pattern from FFmpeg works too:

```sh
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine \
  -c:v libx264 -preset veryfast -b:v 2500k -g 60 -c:a aac \
  -f flv "rtmp://stream.example.org/live/<channel>?key=<secret>"
```

Check the instance with `sh ~/commonair/selfhost.sh status` at any time.
