#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# selfhost.sh: install, upgrade, back up and inspect a CommonAir instance on one Linux host
# (Debian 13 or Fedora 42+, rootless Podman 5 under systemd). ADR 0023 §8 and §9.
#
# It needs no Bun, Node or git on the host: anything that needs Bun runs in the release's
# `tools` image. It downloads only over HTTPS from the release URL, verifies SHA256SUMS (and its
# Sigstore signature when cosign is installed) before using any download, and never pipes a
# download into a shell. Run `selfhost.sh --help` for usage.
set -eu

# The one place the release URL comes from (it equals SITE.repository.url; a test enforces it).
# Forks set COMMONAIR_REPOSITORY_URL on the first install; later runs read it from the installed
# release (release.env, written by bundle.ts), so a fork never silently upgrades from upstream.
DEFAULT_REPOSITORY_URL="https://github.com/abolishus/commonair"
REPOSITORY_URL="${COMMONAIR_REPOSITORY_URL:-}"
OIDC_ISSUER="https://token.actions.githubusercontent.com"
CHECKSUMS_ASSET="SHA256SUMS"
SIGNATURE_ASSET="SHA256SUMS.sigstore.json"

# Tests point these at fixtures; operators never need to.
SYSROOT="${COMMONAIR_SYSROOT:-}"
HEALTH_TIMEOUT="${COMMONAIR_HEALTH_TIMEOUT:-900}"
# The first IRC certificate sync at install: short, because with ACME before DNS points here
# there is no certificate to wait for; the timer retries later.
IRC_CERT_TIMEOUT="${COMMONAIR_IRC_CERT_TIMEOUT:-60}"
POLL_INTERVAL="${COMMONAIR_POLL_INTERVAL:-5}"
# Tries per image pull when the registry fails transiently (5 s, 15 s, 45 s apart).
PULL_ATTEMPTS=4

DATA_DIR="$HOME/.local/share/commonair"
RELEASES_DIR="$DATA_DIR/releases"
PREVIOUS_LINK="$DATA_DIR/previous"
# Units bind-mount their config from %h/commonair/infra/…: a symlink to the current release, so
# a rollback is a symlink flip plus the previous release's units.
CURRENT_LINK="$HOME/commonair"
CONF_DIR="$HOME/.config/commonair"
ENV_FILE="$CONF_DIR/commonair.env"
# Per-unit copies of the keys each unit needs (scripts/selfhost/render-env.sh writes them).
UNIT_ENV_DIR="$CONF_DIR/unit-env"
SELFHOST_CONF="$CONF_DIR/selfhost.conf"
QUADLET_DIR="$HOME/.config/containers/systemd"
# The release's units that only some instances run (whisper with captions on, seed mode's while
# it is open: unit_in_mode) live in this directory of the bundle, the rest in quadlet/. Every
# selfhost.sh up to 0.1.0-rc.2 installs all of quadlet/* and waits for each to become healthy, so
# an upgrade it ran would otherwise start them too (rc.3 on staging: a whisper unit without its
# weights, and seed mode's mocks with seed mode closed).
OPTIONAL_UNIT_DIR="quadlet-optional"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_USER="commonair"
REQUIRED_PODMAN_MAJOR=5
REQUIRED_SYSTEMD=254 # RestartSteps= / RestartMaxDelaySec= in the units

TMP_ROOT=""
cleanup() {
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then rm -rf "$TMP_ROOT"; fi
}
trap cleanup EXIT INT TERM

say() { printf '%s\n' "$*"; }
info() { printf 'selfhost: %s\n' "$*" >&2; }
warn() { printf 'selfhost: WARNING: %s\n' "$*" >&2; }
die() {
  printf 'selfhost: error: %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

usage() {
  cat <<'EOF'
Usage: selfhost.sh <command> [options]

Commands:
  install    Install a CommonAir release on this host and start it.
  upgrade    Upgrade to another release: verify, pull by digest, back up, migrate first,
             restart, wait for health; roll back to the previous release if health fails.
  backup     Take a WAL-G base backup now and list the backups; with --objects, copy the media
             and evidence buckets to the offsite store (docs/self-hosting/backups.md).
  status     Show the installed version, every unit's state and health, TLS, backups, disk use;
             with external Postgres and Valkey, their reachability, TLS, version and load.
  reset-staging
             Staging only: drop the database, flush Valkey, migrate, restart, so that
             `seed full` can fill it again (docs/self-hosting/upgrades.md, "Resetting a
             staging instance"). Every row is gone afterwards; there is no backup first.
  seed-mode open|run|live|coverage|close
             Staging only: open a time-limited seed mode (test hooks, mocks, Mailpit, the seed
             harness on this host), run `seed full` (and `seed-coverage`) in it with live
             streams kept running, close it again (docs/testing/seeding.md, "Seeding staging";
             ADR 0040).
  --help     Show this help.

install options:
  --version vX.Y.Z      Release to download (over HTTPS from the project's release page).
  --bundle <path>       Install from a local commonair-selfhost_<version>.tar.gz instead
                        (offline). A SHA256SUMS next to it (or --sha256sums) is verified.
  --sha256sums <path>   SHA256SUMS for --bundle, if it is not next to the bundle.
  --domain <host>       Public hostname (PUBLIC_HOSTNAME). Required on the first install.
  --email <address>     Operator contact: ACME expiry notices and the instance contacts
                        (security, abuse, DMCA, privacy). Required on the first install.
  --tls acme|internal   acme (default): publicly trusted certificates. internal: Caddy's own
                        CA, for LAN and test hosts.
  --registry <host/ns>  Pull our images from a mirror holding the same digests (cosign copy).
  --public-ip <a,b>     Addresses WebRTC (WHIP) clients reach this host on. Default: this
                        host's global interface addresses (never a "what is my IP" service).
  --model <path>        Use a local copy of the moderation model instead of downloading it.
  --turn-relay          Turn on coturn's TURN relay for P2P viewers behind strict NATs
                        (docs/self-hosting/p2p.md): opens the relay UDP range. STUN on
                        3478/udp is always on. Kept in commonair.env until --no-turn-relay.
  --no-turn-relay       Turn the TURN relay off. Without either flag the setting is kept
                        (off on a first install).
  --web-push            Offer browser push notifications (WEB_PUSH_ENABLED; viewers still opt
                        in per browser; docs/self-hosting/web-push.md). Pushes go through the
                        browser vendor's push service. Kept in commonair.env until --no-web-push.
  --no-web-push         Turn browser push off. Without either flag the setting is kept (off on
                        a first install).
  --captions            Run the live captions sidecar, whisper.cpp (docs/self-hosting/captions.md):
                        about two busy CPU cores while captioned streams are live. On amd64
                        the CPU needs AVX2, FMA and F16C (checked first). Downloads and
                        verifies its weights (57 MiB). Kept in commonair.env until --no-captions.
  --no-captions         Turn live captions off and remove the sidecar. Without either flag the
                        setting is kept (off on a first install).
  --captions-model <path>
                        Use a local copy of the captions weights instead of downloading them.
  --require-signature   Fail unless cosign verifies SHA256SUMS against the release workflow.
  --insecure-no-checksum
                        Offline only: accept a --bundle with no SHA256SUMS. Its integrity is
                        then not checked at all; never use it for a downloaded bundle.
  --unsupported-distro  Continue on a distribution other than Debian 13 or Fedora 42+.
  --reinstall           Allow install over an existing instance. Secrets and edits to
                        commonair.env are kept. Without --version/--bundle it reuses the
                        installed release: the way to apply edits to commonair.env.
  --yes                 As root only: allow the host preparation below. It never implies
                        --reinstall.

object storage (install only; default: Garage on this host). Any of these selects an external
S3-compatible store instead (docs/self-hosting/object-storage.md), chosen once: an instance
never switches store (there is no --migrate-objects; see backups.md for copying objects).
  --s3-endpoint <url>   The store's S3 endpoint, https://host[:port] (required for external).
  --s3-region <region>  The region requests are signed for (required for external).
  --s3-path-style true|false
                        Path-style URLs (endpoint/bucket/key). Default true.
  --s3-public-endpoint <url>
                        Where browsers reach the store (presigned uploads and export
                        downloads). Default: --s3-endpoint.
  --s3-bucket-media <b>, --s3-bucket-exports <b>, --s3-bucket-backups <b>,
  --s3-bucket-evidence <b>
                        Bucket names (default commonair-media, -exports, -backups, -evidence).
                        You create them; storage-init checks each before the services start.
  --s3-allow-http       Accept http:// endpoints (a store on a trusted LAN or a test host).
  Keys never go on the command line: export S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
  S3_EVIDENCE_ACCESS_KEY_ID and S3_EVIDENCE_SECRET_ACCESS_KEY, or install prompts for them.
  They are kept in commonair.env (mode 0600); a --reinstall without them keeps the stored ones.

Postgres and Valkey (install only; default: both in containers on this host, with WAL-G backups).
The two flags below select external servers instead, a managed service such as DigitalOcean's
(docs/self-hosting/managed-services.md), chosen once, together: an instance never switches
between bundled and external (that is a dump and restore, not a flag).
  --database-url <url>  The owner's URL, postgres://<user>@<host>[:port]/<database>?sslmode=verify-full.
                        The user needs CREATEROLE, not superuser; PostgreSQL 17 or 18.
  --database-ca <file>  The PEM CA that signed the server's certificate (DigitalOcean: "Download
                        CA certificate"). Without it the system's trusted CAs are used; on a
                        --reinstall or upgrade, "system" drops the CA install recorded.
  --valkey-url <url>    rediss://[<user>@]<host>[:port][/<db>]; no user: the default user.
  --valkey-ca <file>    The PEM CA that signed Valkey's certificate ("system" as above).
  --allow-insecure-database
                        Accept sslmode=require or disable (a server on a private network).
  --allow-insecure-valkey
                        Accept redis:// without TLS (a server on a private network).
  Passwords never go on the command line: export DATABASE_PASSWORD and VALKEY_PASSWORD, or
  install prompts for them. They are kept only in Podman secrets, never in commonair.env; a
  --reinstall or upgrade without them keeps the stored ones. A preflight checks TLS, the owner's
  rights, the server version, the connection budget and Valkey's eviction policy before anything
  is installed. DATABASE_POOL_MAX in the environment sets the pool size the budget assumes.

upgrade options: --version | --bundle, --sha256sums, --registry, --require-signature,
  --insecure-no-checksum, --turn-relay | --no-turn-relay, --web-push | --no-web-push,
  --captions | --no-captions, --captions-model, --database-ca, --valkey-ca (a new CA for
  external servers). The object store, Postgres and Valkey stay as installed.

backup options (no option: --database):
  --database            A WAL-G base backup of Postgres now, then the list of base backups.
  --objects             Copy the media and evidence buckets to the offsite S3 store set by the
                        BACKUP_OBJECTS_REMOTE_* keys of commonair.env (rclone sync). Together
                        with --database, the database goes first. The first success enables
                        commonair-object-backup.timer (daily).
  --restore-objects     Copy the offsite copy back into this instance's buckets (rclone copy:
                        nothing on the instance is deleted). On its own only.
  --bwlimit <rate>      rclone's bandwidth limit for --objects and --restore-objects, e.g. 20M
                        (bytes/s) or "08:00,4M 23:00,off". Default: BACKUP_OBJECTS_BWLIMIT.
  --max-delete <n|off>  With --objects: stop and fail once a bucket's copy would lose more than
                        n objects in one run. Default: BACKUP_OBJECTS_MAX_DELETE, else 1000.
  --allow-empty-source  With --objects: copy a bucket that is empty although its offsite copy
                        is not, which empties the copy. Refused without it.
  --objects is refused while another --objects or --restore-objects runs, and after a
  --restore-objects that did not finish, until a re-run of it succeeds.
  Exit status 0 on success, 1 on any failure. A successful --objects run records its time in
  ~/.local/state/commonair/object-backup, which status shows.

reset-staging options (refused unless commonair.env has DEMO_SEED_FULL=true, which only local
and staging instances set):
  --confirm <host>      Required: this instance's PUBLIC_HOSTNAME, exactly.
  --base-seed           Also run the basic demo seed (demo:seed) afterwards. Its users make
                        `seed full` refuse, so use it only for a staging that stays basic.
  Object storage (VODs, clips) is not wiped: stale objects are harmless.

seed-mode (refused unless commonair.env has DEMO_SEED_FULL=true; open, run, live and coverage
need --confirm with this instance's PUBLIC_HOSTNAME):
  open --confirm <host> [--hours N]
                        Save the values it changes, write the seed-mode block into commonair.env
                        (every test hook, the scripted classifier and synthetic hash lists,
                        private-network outbound, federation and the Twitch import against the
                        harness, Stripe against stripe-mock, all email to Mailpit, the seed's cost
                        model and governance bootstrap), turn on giveaways, the watch gate, the
                        surge guard and push, start stripe-mock, Mailpit and the seed harness, and
                        restart. Needs live captions on. It closes itself after N hours (default
                        and most: 6). Refuses while seed mode is open.
  run --confirm <host> [--scale small|medium] [--seed n] [--from <unit>]
                        Run `seed full` (default --scale medium) in the harness container, after
                        reset-staging, then start `seed live` there: three seeded channels stream
                        with chat until close. DEMO_SEED_PASSWORD, if set, is the accounts'
                        password; otherwise the run makes one up and prints it. The store report
                        goes to ~/.local/share/commonair/seed-mode/reports/seed-store.json.
                        It runs one unit at a time and dumps the database after each (reports/
                        snapshots/). --from <unit> resumes a failed run there: it restores the
                        dump taken after the unit before, then runs <unit> and the rest (needs the
                        first run's DEMO_SEED_PASSWORD).
  live --confirm <host> (Re)start `seed live` there (needs DEMO_SEED_PASSWORD), e.g. after the
                        harness restarted.
  coverage --confirm <host>
                        Run the seed-coverage scenario there (needs DEMO_SEED_PASSWORD).
  close                 Stop `seed live`, remove the block and restore exactly the values it
                        replaced, remove the mocks, Mailpit, the harness and the drop-ins, restart.
                        Giveaways, the watch gate, the surge guard and push stay on; the seeded data
                        stays. Safe to run again; the close timer runs it at the deadline.
  upgrade and install --reinstall are refused while seed mode is open.

A fork's releases: set COMMONAIR_REPOSITORY_URL=https://… for the first install; later
upgrades use the repository recorded in the installed release. A fork whose code still
carries upstream's SITE.repository.url records upstream's, so set the variable on every
upgrade too (docs/self-hosting/upgrades.md, "A fork's releases").

Run install as the user that will own the instance. Run it as root on a fresh server and it
installs Podman, creates the `commonair` user, enables linger, lowers the unprivileged-port
sysctl to 80 and then continues as that user.
EOF
}

# --- small helpers ------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# Podman's helpers. aardvark-dns and nftables are only Recommends of netavark on Debian, so a
# Podman installed without recommends starts no container on a bridge network ("unable to execute
# nft"). /usr/sbin is not on an unprivileged user's PATH on Debian, hence the explicit paths.
have_catatonit() { [ -x "$SYSROOT/usr/libexec/podman/catatonit" ] || have catatonit; }
have_aardvark() {
  for _d in /usr/lib/podman /usr/libexec/podman /usr/local/lib/podman /usr/local/libexec/podman; do
    [ -x "$SYSROOT$_d/aardvark-dns" ] && return 0
  done
  have aardvark-dns
}
have_nft() { [ -x "$SYSROOT/usr/sbin/nft" ] || have nft; }

make_tmp() {
  if [ -z "$TMP_ROOT" ]; then
    TMP_ROOT=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/commonair-selfhost.XXXXXX")
  fi
}

# Value of KEY in an env file (first match; empty when absent).
env_get() {
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | head -n 1
}

# Set KEY=VALUE in the env file, replacing an existing line or appending one. Values are
# validated by the callers (no newlines), and the file stays 0600. The key and value reach awk
# through its environment, never its argv: a command line is world-readable in ps and
# /proc/<pid>/cmdline, and the values include passwords (DATABASE_URL).
env_set() {
  _tmp="$ENV_FILE.tmp"
  (
    umask 077
    SELFHOST_KEY="$1" SELFHOST_VALUE="$2" awk '
      BEGIN { k = ENVIRON["SELFHOST_KEY"]; v = ENVIRON["SELFHOST_VALUE"]; done = 0 }
      index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$ENV_FILE" >"$_tmp"
  )
  chmod 600 "$_tmp"
  mv "$_tmp" "$ENV_FILE"
}

# Set KEY only when it is missing or empty (keeps an operator's edits).
env_default() {
  if [ -z "$(env_get "$1" "$ENV_FILE")" ]; then env_set "$1" "$2"; fi
}

is_hostname() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
}
is_email() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; }
is_registry() { printf '%s' "$1" | grep -Eq '^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)*$'; }
is_version() {
  printf '%s' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
}
is_addresses() { printf '%s' "$1" | grep -Eq '^[0-9A-Fa-f.:]+(,[0-9A-Fa-f.:]+)*$'; }

# Integer part of a dotted version, field N (1-based).
version_field() { printf '%s' "$1" | sed 's/^[^0-9]*//' | cut -d. -f"$2" | sed 's/[^0-9].*//'; }

installed_version() {
  env_get COMMONAIR_VERSION "$CURRENT_LINK/release.env"
}

instance_exists() { [ -f "$ENV_FILE" ] || [ -L "$CURRENT_LINK" ]; }

# The environment wins, then the installed release's own repository, then ours.
resolve_repository_url() {
  if [ -z "$REPOSITORY_URL" ]; then REPOSITORY_URL=$(env_get COMMONAIR_REPOSITORY_URL "$CURRENT_LINK/release.env"); fi
  REPOSITORY_URL=${REPOSITORY_URL:-$DEFAULT_REPOSITORY_URL}
  case "$REPOSITORY_URL" in
    https://*) ;;
    *) die "the release repository must be an https:// URL, not $REPOSITORY_URL" ;;
  esac
}

# --- host checks --------------------------------------------------------------------------

check_distro() {
  _osr="$SYSROOT/etc/os-release"
  [ -r "$_osr" ] || die "cannot read /etc/os-release" "fix: run on Debian 13 or Fedora 42+"
  _id=$(sed -n 's/^ID=//p' "$_osr" | tr -d '"' | head -n 1)
  _ver=$(sed -n 's/^VERSION_ID=//p' "$_osr" | tr -d '"' | head -n 1)
  _ok=no
  case "$_id" in
    debian) [ "$(version_field "$_ver" 1)" = 13 ] && _ok=yes ;;
    fedora) [ "$(version_field "$_ver" 1)" -ge 42 ] 2>/dev/null && _ok=yes ;;
  esac
  if [ "$_ok" = yes ]; then return 0; fi
  if [ "$UNSUPPORTED_DISTRO" = yes ]; then
    warn "unsupported distribution ${_id:-unknown} ${_ver:-?}; continuing because of --unsupported-distro"
    return 0
  fi
  die "unsupported distribution: ${_id:-unknown} ${_ver:-?}" \
    "fix: use Debian 13 or Fedora 42+, or pass --unsupported-distro to accept an untested host"
}

check_podman() {
  have podman || die "podman is not installed" \
    "fix: run this script as root once (it installs Podman), or: apt install podman / dnf install podman"
  if ! _pv=$(podman version --format '{{.Client.Version}}' 2>/dev/null); then
    # Podman is there but cannot start for this user: report why rather than a version.
    _why=$(podman version 2>&1 | tail -n 3 || true)
    case "$_why" in
      *newuidmap* | *newgidmap*)
        die "podman does not run as $(id -un): newuidmap/newgidmap cannot set up the user namespace" \
          "fix: they need setuid or file capabilities: sudo dnf reinstall shadow-utils / sudo apt install --reinstall uidmap" ;;
      *) die "podman does not run as $(id -un): $_why" "fix: run 'podman info' as $(id -un) to see why" ;;
    esac
  fi
  _major=$(version_field "$_pv" 1)
  if [ -z "$_major" ] || [ "$_major" -lt "$REQUIRED_PODMAN_MAJOR" ]; then
    die "Podman ${_pv:-unknown} is too old (need ${REQUIRED_PODMAN_MAJOR}.0 or newer)" \
      "fix: upgrade to the distribution's Podman 5 (Debian 13 and Fedora 42 ship it)"
  fi
  have_catatonit || die "catatonit is missing (every unit runs with RunInit=true)" \
    "fix: apt install catatonit / dnf install catatonit"
  have_aardvark || die "aardvark-dns is missing (the units find each other by name on the commonair network)" \
    "fix: apt install aardvark-dns / dnf install aardvark-dns"
  have_nft || die "nft is missing (Podman's netavark sets up the commonair network with nftables)" \
    "fix: apt install nftables / dnf install nftables"
}

check_systemd() {
  have systemctl || die "systemd is required" "fix: use Debian 13 or Fedora 42+"
  _sv=$(systemctl --version 2>/dev/null | head -n 1 | awk '{print $2}' | sed 's/[^0-9].*//')
  if [ -z "$_sv" ] || [ "$_sv" -lt "$REQUIRED_SYSTEMD" ]; then
    die "systemd ${_sv:-unknown} is too old (need $REQUIRED_SYSTEMD or newer for RestartSteps=)" \
      "fix: use Debian 13 or Fedora 42+"
  fi
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    die "no systemd user manager for $(id -un)" \
      "fix: log in as this user over SSH or with 'machinectl shell $(id -un)@' (su and sudo do not start one; Debian: apt install systemd-container for machinectl)"
  fi
}

check_rootless() {
  _user=$(id -un)
  _uid=$(id -u)
  for _f in subuid subgid; do
    if ! grep -Eq "^($_user|$_uid):" "$SYSROOT/etc/$_f" 2>/dev/null; then
      die "no /etc/$_f entry for $_user (rootless Podman needs one)" \
        "fix: sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $_user"
    fi
  done
  _linger=$(loginctl show-user "$_user" --property=Linger --value 2>/dev/null || true)
  if [ "$_linger" != yes ]; then
    die "linger is off for $_user, so the instance would stop at logout" \
      "fix: sudo loginctl enable-linger $_user"
  fi
  _start=$(cat "$SYSROOT/proc/sys/net/ipv4/ip_unprivileged_port_start" 2>/dev/null || echo 1024)
  if [ "$_start" -gt 80 ]; then
    die "net.ipv4.ip_unprivileged_port_start is $_start, so Caddy cannot bind 80/443 rootless" \
      "fix: echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/90-commonair.conf && sudo sysctl --system"
  fi
}

# Public ports: Caddy 80/443 (+443/udp HTTP/3), RTMP 1935, IRC 6667/6697, WebRTC ICE 8189/udp,
# coturn's STUN (and TURN) 3478/udp. The TURN relay's range is not checked: coturn takes a free
# port from it for each allocation.
check_ports() {
  have ss || { warn "ss not found; skipping the free-port check"; return 0; }
  _busy=""
  _tcp=$(ss -Hltn 2>/dev/null | awk '{print $4}' | sed 's/.*://')
  _udp=$(ss -Hlun 2>/dev/null | awk '{print $4}' | sed 's/.*://')
  for _p in 80 443 1935 6667 6697; do
    if printf '%s\n' "$_tcp" | grep -qx "$_p"; then _busy="$_busy $_p/tcp"; fi
  done
  for _p in 443 8189 3478; do
    if printf '%s\n' "$_udp" | grep -qx "$_p"; then _busy="$_busy $_p/udp"; fi
  done
  if [ -n "$_busy" ]; then
    die "ports already in use:$_busy" \
      "fix: stop whatever listens there (sudo ss -ltnup shows it), e.g. a web server on 80/443"
  fi
}

firewall_hints() {
  _turn_relay=""
  if turn_relay_on; then _turn_relay=$(turn_relay_range); fi
  if have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    info "firewalld is running; open the public ports (IPv4 and IPv6):"
    info "  sudo firewall-cmd --permanent --add-port={80,443,1935,6667,6697}/tcp --add-port={443,8189,3478}/udp && sudo firewall-cmd --reload"
    if [ -n "$_turn_relay" ]; then
      info "and the TURN relay's range: sudo firewall-cmd --permanent --add-port=$_turn_relay/udp && sudo firewall-cmd --reload"
    fi
  elif have nft; then
    info "if an nftables ruleset filters input, allow tcp dports {80,443,1935,6667,6697} and udp dports {443,8189,3478}, for IPv4 and IPv6 (an inet table covers both)"
    if [ -n "$_turn_relay" ]; then info "and, for the TURN relay, udp dport $_turn_relay"; fi
  fi
  if [ -n "$_turn_relay" ]; then
    warn "the TURN relay is on: open UDP $_turn_relay in your provider's firewall by hand as well; DigitalOcean's cloud firewall (infra/tofu) opens single ports only, so it blocks the range (docs/self-hosting/p2p.md)"
  fi
}

# The public ports listen on IPv6 too wherever the host has it: say whether AAAA records work.
ipv6_hint() {
  have ip || return 0
  _v6=$(ip -o -6 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)
  if [ -n "$_v6" ]; then
    info "this host has the global IPv6 address $_v6: the public ports listen on it too, so an AAAA record may point here"
  else
    info "no global IPv6 address: the public ports listen on IPv4 only; publish an A record, no AAAA"
  fi
}

# ADR 0012 decision 2: live and VOD segment timestamps come from the host clock, so it must be
# NTP-synchronized. A warning only: the instance runs either way, and some hosts (containers,
# minimal images) cannot answer the question at all.
check_time_sync() {
  _ntp_doc="docs/self-hosting/requirements.md#time-synchronization"
  _ntp=""
  if have timedatectl; then _ntp=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true); fi
  case "$_ntp" in
    yes) ;;
    no)
      warn "the host clock is not NTP-synchronized, so live and VOD segment timestamps drift with it" \
        "(enable systemd-timesyncd with 'sudo timedatectl set-ntp true', or chrony; $_ntp_doc)"
      ;;
    *) warn "could not check that the host clock is NTP-synchronized (timedatectl gave no answer; $_ntp_doc)" ;;
  esac
}

host_checks() {
  check_distro
  check_podman
  check_systemd
  check_rootless
  # Our own containers hold these ports on a re-install or upgrade.
  if ! instance_exists; then check_ports; fi
  firewall_hints
  ipv6_hint
  check_time_sync
}

# --- root preparation ---------------------------------------------------------------------

# On a fresh server as root: packages, the service user, linger and the port sysctl. Then the
# rest runs as that user through runuser (util-linux, on both distros) with the user manager's
# XDG_RUNTIME_DIR and bus, which linger keeps running. runuser rather than printing a command:
# the operator asked for one command, and runuser needs no extra package or interactive login.
root_prepare() {
  check_distro
  _osid=$(sed -n 's/^ID=//p' "$SYSROOT/etc/os-release" | tr -d '"' | head -n 1)
  if ! have podman || ! have runuser || ! have_catatonit || ! have_aardvark || ! have_nft; then
    case "$_osid" in
      debian)
        info "installing podman and its helpers (apt)"
        DEBIAN_FRONTEND=noninteractive apt-get update -q
        DEBIAN_FRONTEND=noninteractive apt-get install -y -q podman catatonit uidmap passt aardvark-dns nftables dbus-user-session curl ca-certificates rclone
        ;;
      fedora)
        info "installing podman and its helpers (dnf)"
        dnf install -y -q podman catatonit passt aardvark-dns nftables curl rclone
        ;;
      *) die "cannot install podman on ${_osid:-this distribution}" "fix: install Podman 5, catatonit, aardvark-dns and nftables, then re-run" ;;
    esac
  fi
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    info "creating user $SERVICE_USER"
    # useradd allocates /etc/subuid and /etc/subgid ranges on both distributions.
    useradd --create-home --shell /bin/sh --comment "CommonAir" "$SERVICE_USER"
  fi
  loginctl enable-linger "$SERVICE_USER"
  _start=$(cat "$SYSROOT/proc/sys/net/ipv4/ip_unprivileged_port_start" 2>/dev/null || echo 1024)
  if [ "$_start" -gt 80 ]; then
    info "allowing unprivileged ports from 80 (/etc/sysctl.d/90-commonair.conf)"
    printf 'net.ipv4.ip_unprivileged_port_start=80\n' >"$SYSROOT/etc/sysctl.d/90-commonair.conf"
    sysctl -q -w net.ipv4.ip_unprivileged_port_start=80
  fi
}

# Re-runs this script as the service user with the original arguments.
#
# The user needs read access to the script, a local bundle and the model. Root stages them in a
# fresh root-owned directory (mktemp in /var/tmp) that the user can read but not write: root never
# writes into a path the service user controls, where a planted symlink would turn a root cp or
# chown into a write to any file (the uid a rootless container escape lands on).
run_as_service_user() {
  _uid=$(id -u "$SERVICE_USER")
  _home=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
  _rt="$SYSROOT/run/user/$_uid"
  _i=0
  while [ ! -S "$_rt/bus" ] && [ ! -S "$_rt/systemd/private" ]; do
    _i=$((_i + 1))
    [ "$_i" -le 30 ] || die "the user manager for $SERVICE_USER did not start" "fix: systemctl status user@$_uid.service"
    sleep 1
  done
  _stage=$(stage_for_service_user)
  info "continuing as $SERVICE_USER"
  _rc=0
  # The flags are split on spaces only: a database URL's ? and an IPv6 host's [ ] must not glob.
  set -f
  # shellcheck disable=SC2046,SC2016 # validated flags without spaces; $HOME/$@ expand in the inner sh
  runuser -u "$SERVICE_USER" -- env HOME="$_home" XDG_RUNTIME_DIR="$_rt" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$_rt/bus" sh -c 'cd "$HOME" && exec sh "$@"' sh \
    "$_stage/selfhost.sh" install $(user_args "$_stage") || _rc=$?
  set +f
  rm -rf "$_stage"
  exit "$_rc"
}

# Copies the script and the local inputs into a new root-owned, world-readable directory and
# prints its path. mktemp creates it (0700, root), so nothing the service user made is written to.
# Root copies files the operator named, which may sit in a directory another user controls.
# Refusing symlinks keeps root from reading an arbitrary file into the world-readable stage.
stage_copy() {
  if [ -L "$1" ]; then
    rm -rf "$_st"
    die "refusing to stage a symlink as root: $1 (pass the real file)"
  fi
  cp "$1" "$2"
}

stage_for_service_user() {
  _st=$(mktemp -d "$SYSROOT/var/tmp/commonair-install.XXXXXX")
  stage_copy "$0" "$_st/selfhost.sh"
  if [ -n "$BUNDLE" ]; then
    stage_copy "$BUNDLE" "$_st/$(basename "$BUNDLE")"
    _sums="${SUMS_FILE:-$(dirname "$BUNDLE")/$CHECKSUMS_ASSET}"
    if [ -f "$_sums" ]; then
      stage_copy "$_sums" "$_st/$CHECKSUMS_ASSET"
      _sig="$(dirname "$_sums")/$SIGNATURE_ASSET"
      if [ -f "$_sig" ]; then stage_copy "$_sig" "$_st/$SIGNATURE_ASSET"; fi
    fi
  fi
  if [ -n "$MODEL_SRC" ]; then stage_copy "$MODEL_SRC" "$_st/model.onnx"; fi
  if [ -n "$CAPTIONS_MODEL_SRC" ]; then stage_copy "$CAPTIONS_MODEL_SRC" "$_st/captions-model.bin"; fi
  # Certificates only, public by nature: world-readable in the stage is fine.
  if [ -n "$DB_OPT_CA" ] && [ "$DB_OPT_CA" != system ]; then stage_copy "$DB_OPT_CA" "$_st/database-ca.pem"; fi
  if [ -n "$VK_OPT_CA" ] && [ "$VK_OPT_CA" != system ]; then stage_copy "$VK_OPT_CA" "$_st/valkey-ca.pem"; fi
  chmod 0644 "$_st"/*
  chmod 0755 "$_st"
  printf '%s' "$_st"
}

# Flags for the re-run as the service user, with local files moved to the staging directory.
user_args() {
  _out=""
  [ -n "$VERSION" ] && _out="$_out --version v$VERSION"
  [ -n "$BUNDLE" ] && _out="$_out --bundle $1/$(basename "$BUNDLE")"
  [ -n "$DOMAIN" ] && _out="$_out --domain $DOMAIN"
  [ -n "$EMAIL" ] && _out="$_out --email $EMAIL"
  [ -n "$TLS" ] && _out="$_out --tls $TLS"
  [ -n "$REGISTRY" ] && _out="$_out --registry $REGISTRY"
  [ -n "$PUBLIC_IP" ] && _out="$_out --public-ip $PUBLIC_IP"
  [ -n "$MODEL_SRC" ] && _out="$_out --model $1/model.onnx"
  [ -n "$CAPTIONS_MODEL_SRC" ] && _out="$_out --captions-model $1/captions-model.bin"
  [ -n "$CAPTIONS" ] && _out="$_out --$([ "$CAPTIONS" = on ] || printf 'no-')captions"
  [ -n "$TURN_RELAY" ] && _out="$_out --$([ "$TURN_RELAY" = on ] || printf 'no-')turn-relay"
  [ -n "$WEB_PUSH" ] && _out="$_out --$([ "$WEB_PUSH" = on ] || printf 'no-')web-push"
  [ "$REQUIRE_SIGNATURE" = yes ] && _out="$_out --require-signature"
  [ "$INSECURE_NO_CHECKSUM" = yes ] && _out="$_out --insecure-no-checksum"
  [ "$UNSUPPORTED_DISTRO" = yes ] && _out="$_out --unsupported-distro"
  # --yes was root's consent to prepare the host; reinstalling needs its own (--reinstall).
  [ "$REINSTALL" = yes ] && _out="$_out --reinstall"
  # The S3 keys are not flags: they reach the service user's run through the environment, which
  # runuser keeps.
  [ -n "$S3_OPT_ENDPOINT" ] && _out="$_out --s3-endpoint $S3_OPT_ENDPOINT"
  [ -n "$S3_OPT_REGION" ] && _out="$_out --s3-region $S3_OPT_REGION"
  [ -n "$S3_OPT_PATH_STYLE" ] && _out="$_out --s3-path-style $S3_OPT_PATH_STYLE"
  [ -n "$S3_OPT_PUBLIC" ] && _out="$_out --s3-public-endpoint $S3_OPT_PUBLIC"
  [ -n "$S3_OPT_BUCKET_MEDIA" ] && _out="$_out --s3-bucket-media $S3_OPT_BUCKET_MEDIA"
  [ -n "$S3_OPT_BUCKET_EXPORTS" ] && _out="$_out --s3-bucket-exports $S3_OPT_BUCKET_EXPORTS"
  [ -n "$S3_OPT_BUCKET_BACKUPS" ] && _out="$_out --s3-bucket-backups $S3_OPT_BUCKET_BACKUPS"
  [ -n "$S3_OPT_BUCKET_EVIDENCE" ] && _out="$_out --s3-bucket-evidence $S3_OPT_BUCKET_EVIDENCE"
  [ "$S3_ALLOW_HTTP" = yes ] && _out="$_out --s3-allow-http"
  # Postgres and Valkey: the URLs (validated, no spaces, no password) and the staged CAs. The
  # passwords reach that run through the environment, like the S3 keys.
  [ -n "$DB_OPT_URL" ] && _out="$_out --database-url $DB_OPT_URL"
  case "$DB_OPT_CA" in "") ;; system) _out="$_out --database-ca system" ;; *) _out="$_out --database-ca $1/database-ca.pem" ;; esac
  [ -n "$VK_OPT_URL" ] && _out="$_out --valkey-url $VK_OPT_URL"
  case "$VK_OPT_CA" in "") ;; system) _out="$_out --valkey-ca system" ;; *) _out="$_out --valkey-ca $1/valkey-ca.pem" ;; esac
  [ "$DB_ALLOW_INSECURE" = yes ] && _out="$_out --allow-insecure-database"
  [ "$VK_ALLOW_INSECURE" = yes ] && _out="$_out --allow-insecure-valkey"
  printf '%s' "$_out"
}

# --- release download and verification ----------------------------------------------------

download() {
  info "downloading $1"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 3 --output "$2" "$1"
}

# cosign identity of the release workflow (ADR 0023 §3), derived from the repository URL.
identity_regexp() {
  _escaped=$(printf '%s' "$REPOSITORY_URL" | sed 's/[.]/\\./g')
  printf '^%s/\\.github/workflows/release\\.yml@refs/tags/v' "$_escaped"
}

verify_signature() {
  # $1 = directory holding SHA256SUMS and maybe its signature bundle
  if ! have cosign; then
    if [ "$REQUIRE_SIGNATURE" = yes ]; then
      die "--require-signature: cosign is not installed" \
        "fix: install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) and re-run"
    fi
    warn "cosign is not installed: $CHECKSUMS_ASSET is checked, but its SIGNATURE IS NOT;" \
      "install cosign (or pass --require-signature) so a tampered release page is caught"
    return 0
  fi
  # With cosign installed a missing signature is never skipped: whoever can swap SHA256SUMS can
  # also delete its signature.
  [ -f "$1/$SIGNATURE_ASSET" ] || die "$SIGNATURE_ASSET is missing: refusing a release whose signature cannot be checked" \
    "fix: put the release's $SIGNATURE_ASSET next to its $CHECKSUMS_ASSET (both are release assets)"
  info "verifying the signature of $CHECKSUMS_ASSET with cosign"
  cosign verify-blob --bundle "$1/$SIGNATURE_ASSET" \
    --certificate-identity-regexp "$(identity_regexp)" \
    --certificate-oidc-issuer "$OIDC_ISSUER" \
    "$1/$CHECKSUMS_ASSET" >/dev/null ||
    die "the signature on $CHECKSUMS_ASSET does not verify against $REPOSITORY_URL's release workflow"
}

# Verifies $2 (a file in directory $1) against $1/SHA256SUMS.
verify_checksum() {
  _name=$2
  _line=$(awk -v n="$_name" '$2 == n || $2 == "*" n' "$1/$CHECKSUMS_ASSET")
  [ -n "$_line" ] || die "$CHECKSUMS_ASSET has no entry for $_name"
  (cd "$1" && printf '%s\n' "$_line" | sha256sum -c --status -) ||
    die "checksum mismatch for $_name: refusing to use it" "fix: download it again; if it persists, report it"
  info "checksum ok: $_name"
}

# Leaves the verified bundle path in BUNDLE_PATH and its version in BUNDLE_VERSION.
obtain_bundle() {
  make_tmp
  if [ -n "$BUNDLE" ]; then
    [ -f "$BUNDLE" ] || die "no such bundle: $BUNDLE"
    _base=$(basename "$BUNDLE")
    BUNDLE_VERSION=$(printf '%s' "$_base" | sed -n 's/^commonair-selfhost_\(.*\)\.tar\.gz$/\1/p')
    is_version "$BUNDLE_VERSION" || die "not a release bundle name: $_base (want commonair-selfhost_<version>.tar.gz)"
    _dir="$TMP_ROOT/verify"
    mkdir -p "$_dir"
    cp "$BUNDLE" "$_dir/$_base"
    _sums="${SUMS_FILE:-$(dirname "$BUNDLE")/$CHECKSUMS_ASSET}"
    if [ -f "$_sums" ]; then
      cp "$_sums" "$_dir/$CHECKSUMS_ASSET"
      _sig="$(dirname "$_sums")/$SIGNATURE_ASSET"
      if [ -f "$_sig" ]; then cp "$_sig" "$_dir/$SIGNATURE_ASSET"; fi
      verify_signature "$_dir"
      verify_checksum "$_dir" "$_base"
    else
      if [ "$REQUIRE_SIGNATURE" = yes ]; then die "--require-signature: no $CHECKSUMS_ASSET next to $BUNDLE"; fi
      [ "$INSECURE_NO_CHECKSUM" = yes ] || die "no $CHECKSUMS_ASSET next to $BUNDLE: refusing an unverified bundle" \
        "fix: put the release's $CHECKSUMS_ASSET next to it or pass --sha256sums <path>" \
        "offline with no checksum file at all: --insecure-no-checksum (you vouch for the bundle)"
      warn "--insecure-no-checksum: $BUNDLE is NOT verified; you vouch for its integrity"
    fi
    BUNDLE_PATH="$_dir/$_base"
    return 0
  fi
  [ -n "$VERSION" ] || die "say which release: --version vX.Y.Z or --bundle <path>"
  BUNDLE_VERSION="$VERSION"
  _base="commonair-selfhost_$VERSION.tar.gz"
  _url="$REPOSITORY_URL/releases/download/v$VERSION"
  _dir="$TMP_ROOT/download"
  mkdir -p "$_dir"
  if [ "$REQUIRE_SIGNATURE" = yes ] && ! have cosign; then
    die "--require-signature: cosign is not installed" \
      "fix: install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) and re-run"
  fi
  download "$_url/$CHECKSUMS_ASSET" "$_dir/$CHECKSUMS_ASSET"
  if have cosign; then
    download "$_url/$SIGNATURE_ASSET" "$_dir/$SIGNATURE_ASSET" ||
      die "could not download $SIGNATURE_ASSET: refusing a release whose signature cannot be checked" \
        "fix: check the network and that the release has a $SIGNATURE_ASSET asset"
  fi
  verify_signature "$_dir"
  download "$_url/$_base" "$_dir/$_base"
  verify_checksum "$_dir" "$_base"
  BUNDLE_PATH="$_dir/$_base"
}

# Extracts the verified bundle into releases/<version>; leaves the path in RELEASE_DIR.
extract_bundle() {
  RELEASE_DIR="$RELEASES_DIR/$BUNDLE_VERSION"
  _top="commonair-selfhost_$BUNDLE_VERSION"
  # Even a verified archive may only write below its own top-level directory.
  if tar -tzf "$BUNDLE_PATH" | grep -Ev "^$_top(/|$)" | grep -q .; then
    die "unexpected paths in the bundle: refusing to extract it"
  fi
  if tar -tzf "$BUNDLE_PATH" | grep -Eq '(^|/)\.\.(/|$)'; then
    die "the bundle contains '..' paths: refusing to extract it"
  fi
  mkdir -p "$RELEASES_DIR"
  rm -rf "$RELEASE_DIR.new"
  mkdir -p "$RELEASE_DIR.new"
  tar -xzf "$BUNDLE_PATH" --no-same-owner -C "$RELEASE_DIR.new"
  _got=$(env_get COMMONAIR_VERSION "$RELEASE_DIR.new/$_top/release.env")
  [ "$_got" = "$BUNDLE_VERSION" ] || die "the bundle says version '$_got', its name says $BUNDLE_VERSION"
  rm -rf "$RELEASE_DIR"
  mv "$RELEASE_DIR.new/$_top" "$RELEASE_DIR"
  rm -rf "$RELEASE_DIR.new"
  info "release $BUNDLE_VERSION in $RELEASE_DIR"
}

# Points our own images at a mirror holding the same digests (ADR 0023 §2).
apply_registry() {
  _rel=$1
  _reg=$2
  [ -n "$_reg" ] || return 0
  _from=$(env_get COMMONAIR_REGISTRY "$_rel/release.env")
  [ "$_from" != "$_reg" ] || return 0
  for _u in "$_rel"/quadlet/*.container "$_rel/$OPTIONAL_UNIT_DIR"/*.container; do
    [ -f "$_u" ] || continue
    sed "s|^Image=$_from/|Image=$_reg/|" "$_u" >"$_u.tmp" && mv "$_u.tmp" "$_u"
  done
  env_set_file "$_rel/release.env" COMMONAIR_REGISTRY "$_reg"
  info "images come from the mirror $_reg"
}

env_set_file() {
  SELFHOST_KEY="$2" SELFHOST_VALUE="$3" awk '
    BEGIN { k = ENVIRON["SELFHOST_KEY"]; v = ENVIRON["SELFHOST_VALUE"] }
    index($0, k "=") == 1 { print k "=" v; next }
    { print }
  ' "$1" >"$1.tmp"
  mv "$1.tmp" "$1"
}

# The images of the units this instance runs (an external object store needs no Garage image).
images_of() {
  for _u in "$1"/quadlet/*.container "$1/$OPTIONAL_UNIT_DIR"/*.container; do
    [ -f "$_u" ] || continue
    if unit_in_mode "$(basename "$_u")"; then sed -n 's/^Image=//p' "$_u"; fi
  done | sort -u
}

# The path of unit $2 in release $1 (quadlet/ or the optional units' directory), or nothing.
release_unit_path() {
  for _rup in "$1/quadlet/$2" "$1/$OPTIONAL_UNIT_DIR/$2"; do
    if [ -f "$_rup" ]; then
      printf '%s' "$_rup"
      return 0
    fi
  done
  return 0
}

tools_image() {
  sed -n 's/^Image=//p' "$1/quadlet/commonair-migrate.container" | head -n 1
}

# Whether a failed pull is worth another try: a registry's 5xx, 429 or 408, a timeout, a dropped
# connection, a DNS server that failed to answer. Podman's own --retry covers only 502-504 and
# network errors, and Docker Hub answers an occasional 500. An auth, not-found or digest error is
# never retried: another try cannot fix it, and a digest that does not match must stop the
# install, not be fetched again.
pull_transient() {
  printf '%s' "$1" | grep -Eqi 'unauthorized|denied|authentication required|manifest unknown|name unknown|not found|status:? 40([0-7]|9)|digest did not match|does not match' &&
    return 1
  printf '%s' "$1" | grep -Eqi 'status:? (5[0-9][0-9]|429|408)|too ?many ?requests|timeout|timed out|deadline exceeded|connection reset|unexpected EOF|service unavailable|bad gateway|temporary failure in name resolution|server misbehaving|network is unreachable|GOAWAY'
}

pull_images() {
  for _img in $(images_of "$1"); do pull_one "$_img"; done
}

pull_one() {
  info "pulling $1"
  _try=1
  _wait=5
  until _err=$(podman pull --quiet "$1" 2>&1 >/dev/null); do
    printf '%s\n' "$_err" >&2
    if [ "$_try" -ge "$PULL_ATTEMPTS" ] || ! pull_transient "$_err"; then
      die "could not pull $1" "fix: check the network and the registry (--registry for a mirror)"
    fi
    warn "pulling $1 failed (attempt $_try of $PULL_ATTEMPTS), retrying in ${_wait}s"
    sleep "$_wait"
    _try=$((_try + 1))
    _wait=$((_wait * 3))
  done
}

# --- instance configuration ---------------------------------------------------------------

# Runs init-env in the tools image (fresh secrets for missing keys, keeps existing ones).
write_env() {
  _rel=$1
  make_tmp
  mkdir -p "$CONF_DIR"
  chmod 700 "$CONF_DIR"
  _work="$TMP_ROOT/env"
  (umask 077 && mkdir -p "$_work")
  if [ -f "$ENV_FILE" ]; then (umask 077 && cp "$ENV_FILE" "$_work/commonair.env"); fi
  info "writing $ENV_FILE (secrets are generated in the tools image and never printed)"
  podman run --rm --user 0:0 --network none --entrypoint bun \
    -v "$_rel/tools:/tools:ro,Z" -v "$_work:/out:Z" -w /tools \
    "$(tools_image "$_rel")" /tools/init-env.js --out /out/commonair.env --merge >/dev/null ||
    die "init-env failed in the tools image"
  # init-env writes only the keys .env.example lists. Carry over every other key the old file
  # had (MTX_WEBRTCADDITIONALHOSTS, operator additions), or each upgrade would drop them.
  if [ -f "$ENV_FILE" ]; then
    (umask 077 && awk -F= '
      NR == FNR { if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*=/) seen[$1] = 1; next }
      /^[A-Za-z_][A-Za-z0-9_]*=/ && !($1 in seen) { print }
    ' "$_work/commonair.env" "$ENV_FILE" >"$_work/carried.env" &&
      cat "$_work/carried.env" >>"$_work/commonair.env")
  fi
  (umask 077 && cp "$_work/commonair.env" "$ENV_FILE.tmp")
  chmod 600 "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  rm -rf "$_work"
}

local_addresses() {
  if have ip; then
    ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | paste -sd, -
  fi
}

# --- P2P: coturn (STUN always; the TURN relay only with --turn-relay) -------------------------
#
# The relay switch is P2P_TURN_URLS in commonair.env: non-empty, the API hands out TURN
# credentials and coturn allocates relays (infra/coturn/start.sh). --turn-relay sets it,
# --no-turn-relay empties it, and without either, install and upgrade keep what is there.

TURN_URL_SUFFIX=":3478?transport=udp"

# Whether the relay is on, or will be with this run's flags.
turn_relay_on() {
  case "${TURN_RELAY:-}" in
    on) return 0 ;;
    off) return 1 ;;
  esac
  [ -n "$(env_get P2P_TURN_URLS "$ENV_FILE")" ]
}

# The relay's UDP range as min-max, from commonair.env or the defaults.
turn_relay_range() {
  _turn_min=$(env_get TURN_RELAY_PORT_MIN "$ENV_FILE")
  _turn_max=$(env_get TURN_RELAY_PORT_MAX "$ENV_FILE")
  printf '%s-%s' "${_turn_min:-49160}" "${_turn_max:-49199}"
}

# The one address coturn advertises: the first IPv4 entry of an address list (MediaMTX's
# MTX_WEBRTCADDITIONALHOSTS may hold IPv4 and IPv6 addresses and host names), else its first
# IPv6 entry, else nothing. (Shell variables are global: these helpers use _turn_* names only,
# so they never clobber a caller's, e.g. cmd_upgrade's _cur.)
turn_address() {
  _turn_v6=""
  for _turn_a in $(printf '%s' "$1" | tr ',' ' '); do
    if printf '%s' "$_turn_a" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
      printf '%s' "$_turn_a"
      return 0
    fi
    if [ -z "$_turn_v6" ] && printf '%s' "$_turn_a" | grep -Eq '^[0-9A-Fa-f:]*:[0-9A-Fa-f:]*$'; then
      _turn_v6=$_turn_a
    fi
  done
  printf '%s' "$_turn_v6"
}

# P2P_TURN_URLS from the switch ($1: the hostname, $2: the previous one). Without --turn-relay
# or --no-turn-relay, a relay URL this script wrote follows a new hostname; an operator's own
# value stays.
turn_env() {
  _turn_url="turn:$1$TURN_URL_SUFFIX"
  _turn_cur=$(env_get P2P_TURN_URLS "$ENV_FILE")
  case "${TURN_RELAY:-}" in
    on) env_set P2P_TURN_URLS "$_turn_url" ;;
    off) env_set P2P_TURN_URLS "" ;;
    *) if [ -n "$2" ] && [ "$_turn_cur" = "turn:$2$TURN_URL_SUFFIX" ]; then env_set P2P_TURN_URLS "$_turn_url"; fi ;;
  esac
  if [ -n "$(env_get P2P_TURN_URLS "$ENV_FILE")" ] && [ -z "$(env_get TURN_SHARED_SECRET "$ENV_FILE")" ]; then
    die "the TURN relay is on but $ENV_FILE has no TURN_SHARED_SECRET" \
      "fix: delete the TURN_SHARED_SECRET line (install and upgrade generate a new one), then re-run"
  fi
}

# --- web push (ADR 0028 decision 1) -------------------------------------------------------
#
# WEB_PUSH_ENABLED in commonair.env: --web-push sets it, --no-web-push clears it, and without
# either, install and upgrade keep what is there. The VAPID pair needs nothing here: write_env's
# init-env --merge generates it on install and on the first upgrade that knows it.
web_push_env() {
  case "${WEB_PUSH:-}" in
    on)
      if [ -z "$(env_get VAPID_PUBLIC_KEY "$ENV_FILE")" ] || [ -z "$(env_get VAPID_PRIVATE_KEY "$ENV_FILE")" ]; then
        die "--web-push needs the VAPID key pair but $ENV_FILE lacks VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY" \
          "fix: delete both VAPID_* lines (install and upgrade generate a new pair), then re-run"
      fi
      env_set WEB_PUSH_ENABLED true
      ;;
    off) env_set WEB_PUSH_ENABLED false ;;
  esac
}

# --- live captions (ADR 0011; docs/self-hosting/captions.md) -------------------------------
#
# The switch is WHISPER_URL in commonair.env: this instance's sidecar address means captions are
# on, so commonair-whisper is installed and its weights fetched; anything else (empty, or an
# operator's own whisper server) leaves the unit out. --captions sets it, --no-captions empties
# it, and without either, install and upgrade keep what is there.

WHISPER_INTERNAL_URL="http://whisper:8080"
WHISPER_UNIT="commonair-whisper.container"

# Whether captions are on, or will be with this run's flags.
captions_on() {
  case "${CAPTIONS:-}" in
    on) return 0 ;;
    off) return 1 ;;
  esac
  [ "$(env_get WHISPER_URL "$ENV_FILE")" = "$WHISPER_INTERNAL_URL" ]
}

captions_env() {
  case "${CAPTIONS:-}" in
    on) env_set WHISPER_URL "$WHISPER_INTERNAL_URL" ;;
    off) env_set WHISPER_URL "" ;;
  esac
  if captions_on && [ "$(env_get CAPTIONS_MAX_STREAMS "$ENV_FILE")" = 0 ]; then
    warn "captions are on but CAPTIONS_MAX_STREAMS=0 in $ENV_FILE: no stream gets captions until you raise it"
  fi
  return 0
}

# The CPU features the release's whisper build needs on this host's architecture (release.env,
# from the manifest's `cpu`), space-separated; empty when it needs none.
whisper_cpu_needs() {
  case "$(uname -m)" in
    x86_64 | amd64) _cap_arch=AMD64 ;;
    aarch64 | arm64) _cap_arch=ARM64 ;;
    *) _cap_arch=$(uname -m | tr '[:lower:]' '[:upper:]') ;;
  esac
  env_get "COMMONAIR_CPU_WHISPER_$_cap_arch" "$1/release.env" | tr ',' ' '
}

# Before anything changes: captions need a release that ships the sidecar, and on amd64 a CPU
# with the features its build was compiled for. whisper.cpp's amd64 build has no fallback path:
# without AVX2 (Intel before Haswell, 2013; AMD before Zen, 2017; some virtual CPUs that hide it)
# whisper-server stops with SIGILL as it starts, the unit would restart it forever and the
# install would never become healthy, so this refuses up front instead.
check_captions() {
  captions_on || return 0
  [ -n "$(release_unit_path "$1" "$WHISPER_UNIT")" ] || die "release $(env_get COMMONAIR_VERSION "$1/release.env") has no captions sidecar ($WHISPER_UNIT)" \
    "fix: re-run with --no-captions, or install a release that ships it"
  _cap_need=$(whisper_cpu_needs "$1")
  [ -n "$_cap_need" ] || return 0
  _cap_flags=$(sed -n 's/^flags[[:space:]]*:[[:space:]]*//p' "$SYSROOT/proc/cpuinfo" 2>/dev/null | head -n 1)
  [ -n "$_cap_flags" ] || die "cannot read this CPU's flags from /proc/cpuinfo; live captions need $_cap_need here" \
    "fix: re-run with --no-captions"
  _cap_missing=""
  for _cap_f in $_cap_need; do
    case " $_cap_flags " in
      *" $_cap_f "*) ;;
      *) _cap_missing="$_cap_missing $_cap_f" ;;
    esac
  done
  [ -z "$_cap_missing" ] || die "live captions need a CPU with $_cap_need; this one lacks:$_cap_missing" \
    "whisper.cpp's build would stop with SIGILL at start (docs/self-hosting/captions.md, 'CPU requirements')" \
    "fix: re-run with --no-captions; everything but captions works on this CPU. On a VM, ask for a CPU model that passes AVX2 through"
  info "captions: this CPU has $_cap_need"
}

configure_env() {
  _host=$DOMAIN
  _old_host=$(env_get PUBLIC_HOSTNAME "$ENV_FILE")
  env_set NODE_ENV production
  env_set PUBLIC_HOSTNAME "$_host"
  env_set PUBLIC_URL "https://$_host"
  env_set API_PUBLIC_URL "https://$_host"
  env_set PLAYBACK_PUBLIC_URL "https://$_host"
  env_set CHAT_PUBLIC_URL "wss://$_host/chat"
  env_set P2P_TRACKER_URL "wss://$_host/tracker"
  env_set MEDIA_PUBLIC_URL "https://$_host/media"
  # Presigned uploads and export downloads go to this host, where Caddy forwards them to Garage
  # (ADR 0024). A re-install keeps an operator's own S3 endpoint: anything but this instance's.
  _s3=$(env_get S3_PUBLIC_ENDPOINT "$ENV_FILE")
  if [ -z "$_s3" ] || [ "$_s3" = "https://$_old_host" ]; then env_set S3_PUBLIC_ENDPOINT "https://$_host"; fi
  env_set INGEST_WHIP_PUBLIC_URL "https://$_host/live"
  env_set INGEST_RTMP_PUBLIC_URL "rtmp://$_host/live"
  env_set IRC_PUBLIC_HOST "$_host"
  env_set TLS_MODE "$TLS"
  if [ -n "$EMAIL" ]; then
    env_set ACME_EMAIL "$EMAIL"
    for _k in CONTACT_EMAIL SECURITY_EMAIL ABUSE_EMAIL DMCA_EMAIL PRIVACY_EMAIL; do env_default "$_k" "$EMAIL"; done
  fi
  # Re-installs keep what the operator set (a NAT address, an earlier --public-ip) unless a new
  # --public-ip is given; local interface addresses are only the first-install guess.
  _ips=${PUBLIC_IP:-$(env_get MTX_WEBRTCADDITIONALHOSTS "$ENV_FILE")}
  _ips=${_ips:-$(local_addresses)}
  if [ -n "$_ips" ]; then
    env_set MTX_WEBRTCADDITIONALHOSTS "$_ips"
  else
    warn "no global address found: set MTX_WEBRTCADDITIONALHOSTS in $ENV_FILE or WHIP ingest will fail remotely"
  fi
  # P2P: this instance's own STUN server (never a public one), and the address coturn
  # advertises, the one MediaMTX uses. A new --public-ip replaces it; otherwise a value stays.
  env_set P2P_STUN_URLS "stun:$_host:3478"
  _turn_ip=$(turn_address "$_ips")
  if [ -n "$PUBLIC_IP" ] && [ -n "$_turn_ip" ]; then
    env_set TURN_EXTERNAL_IP "$_turn_ip"
  elif [ -n "$_turn_ip" ]; then
    env_default TURN_EXTERNAL_IP "$_turn_ip"
  fi
  turn_env "$_host" "$_old_host"
  web_push_env
  captions_env
  # The app-role URL; the services get it as a podman secret as well (create_secrets). External
  # Postgres and Valkey: state_env writes theirs instead.
  if [ "$STATE_MODE" != external ]; then
    _app=$(env_get POSTGRES_APP_PASSWORD "$ENV_FILE")
    env_set DATABASE_URL "postgres://commonair_app:$_app@postgres:5432/commonair"
    valkey_env
  fi
  state_env
  storage_env
}

# Valkey requires VALKEY_PASSWORD (init-env generated it in write_env, on install and, for an
# older env file, on the first upgrade). The services' VALKEY_URL carries it; they get the URL as
# a podman secret (create_secrets), and the env file says the same so it stays the one source.
valkey_env() {
  _vpw=$(env_get VALKEY_PASSWORD "$ENV_FILE")
  [ -n "$_vpw" ] || die "$ENV_FILE has no VALKEY_PASSWORD (Valkey refuses to start without one)" \
    "fix: delete the VALKEY_PASSWORD line (install and upgrade generate a new one) or set one, then re-run"
  case "$_vpw" in
    *[!A-Za-z0-9._~-]*) die "VALKEY_PASSWORD may hold only letters, digits and . _ ~ - (it goes into VALKEY_URL)" ;;
  esac
  env_set VALKEY_URL "redis://:$_vpw@valkey:6379"
}

# Variables an older install never wrote, filled in on upgrade without touching set values.
backfill_env() {
  _host=$(env_get PUBLIC_HOSTNAME "$ENV_FILE")
  [ -n "$_host" ] || return 0
  # Before ADR 0024 presigned URLs pointed at the internal Garage address.
  if [ -z "$(env_get S3_PUBLIC_ENDPOINT "$ENV_FILE")" ]; then
    info "setting S3_PUBLIC_ENDPOINT=https://$_host (browser uploads and export downloads)"
    env_set S3_PUBLIC_ENDPOINT "https://$_host"
  fi
  # Before Valkey had a password, VALKEY_URL was the development default; write_env generated
  # VALKEY_PASSWORD for this upgrade. An external Valkey's URL is state_env's.
  if [ "$STATE_MODE" != external ]; then valkey_env; fi
  # The collector's keys (contract §3.7) and the monitor role's password, new in batch 8.
  state_env
  # Before coturn (P1), write_env's merge just added init-env's development STUN URL and an empty
  # TURN_EXTERNAL_IP. The relay stays as it was unless --turn-relay or --no-turn-relay says.
  case "$(env_get P2P_STUN_URLS "$ENV_FILE")" in
    "" | "stun:localhost:3478")
      info "setting P2P_STUN_URLS=stun:$_host:3478 (this instance's coturn)"
      env_set P2P_STUN_URLS "stun:$_host:3478"
      ;;
  esac
  _turn_ip=$(turn_address "$(env_get MTX_WEBRTCADDITIONALHOSTS "$ENV_FILE")")
  if [ -n "$_turn_ip" ]; then env_default TURN_EXTERNAL_IP "$_turn_ip"; fi
  turn_env "$_host" "$_host"
  web_push_env
  captions_env
  # Releases up to rc.2 pinned Garage's endpoint, region and path style in the units, and the
  # env file held init-env's development values for them. The units now read them from here.
  if [ "$STORAGE_MODE" = garage ] && [ "$(env_get S3_ENDPOINT "$ENV_FILE")" != "$GARAGE_S3_ENDPOINT" ]; then
    info "setting S3_ENDPOINT=$GARAGE_S3_ENDPOINT, S3_REGION=garage, S3_FORCE_PATH_STYLE=true (Garage on this host)"
  fi
  storage_env
}

# --- object storage -----------------------------------------------------------------------
#
# S3_MODE in commonair.env says where the objects live. Unset (or garage), the default: Garage on
# this host, and the env file holds Garage's endpoint, region and path style like any other
# setting (storage_env). `external`: an operator's S3-compatible store, chosen with --s3-endpoint
# on install. Then install_units leaves Garage's unit and volumes out, commonair-storage-init
# checks the operator's buckets instead of bootstrapping Garage, and Caddy has no S3 route
# (infra/caddy/Caddyfile): browsers reach S3_PUBLIC_ENDPOINT directly. Only external mode writes
# S3_MODE, so a Garage install's env file has the keys it always had. The mode never changes on an
# existing instance: nothing here moves objects from one store to the other.

GARAGE_S3_ENDPOINT="http://garage:3900"
# Read from the environment or a prompt, never from flags (ps shows every argument).
S3_KEY_VARS="S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_EVIDENCE_ACCESS_KEY_ID S3_EVIDENCE_SECRET_ACCESS_KEY"

# https://host[:port] (http:// only with --s3-allow-http); no path, no credentials in the URL.
is_s3_url() { printf '%s' "$1" | grep -Eq '^https?://[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[0-9]{1,5})?$'; }
is_s3_region() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$'; }
# S3's bucket rules (as infra/garage/bootstrap.ts checks them): 3-63 of a-z 0-9 . -, no "..".
is_bucket() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' && ! printf '%s' "$1" | grep -q '\.\.'
}
# Access key ids and secrets as stores issue them (base64 or hex, AWS's / + =). printf is a
# builtin and grep reads the value on stdin, so a key never appears in a process list.
is_s3_key() { [ "${#1}" -ge 3 ] && [ "${#1}" -le 256 ] && printf '%s' "$1" | grep -Eq '^[A-Za-z0-9/+=._~-]+$'; }

# Sets STORAGE_MODE from an env file: garage (S3_MODE unset, empty or garage) or external.
read_storage_mode() {
  _m=$(env_get S3_MODE "$1")
  case "$_m" in
    "" | garage) STORAGE_MODE=garage ;;
    external) STORAGE_MODE=external ;;
    *) die "S3_MODE=$_m in $1 is neither garage nor external" "fix: correct the line (an instance keeps the store it was installed with)" ;;
  esac
}

# Whether a unit file of the release belongs to this instance: Garage's only in Garage mode,
# Postgres's and Valkey's only with bundled state, whisper's only with captions on, stripe-mock's,
# Mailpit's and the seed harness's only while staging seed mode is open (ADR 0040).
unit_in_mode() {
  case "$1" in
    commonair-whisper.container) captions_on || return 1 ;;
    commonair-stripe-mock.container | commonair-mailpit.container | commonair-seed-harness.container)
      seed_mode_open || return 1
      ;;
    commonair-postgres.container | commonair-postgres-data.volume | commonair-valkey.container)
      [ "${STATE_MODE:-bundled}" != external ] || return 1
      ;;
  esac
  [ "${STORAGE_MODE:-garage}" = external ] || return 0
  case "$1" in
    commonair-garage.container | commonair-garage-meta.volume | commonair-garage-data.volume) return 1 ;;
  esac
  return 0
}

# The value of KEY in the env file, if it already describes an external store (else nothing).
stored_s3() {
  if [ "$STORAGE_STORED" = yes ]; then env_get "$1" "$STORAGE_ENV"; fi
  return 0
}

# Asks for one key on the terminal (secrets without echo). Fails without a terminal.
prompt_s3_key() {
  [ -t 0 ] || return 1
  printf 'selfhost: %s: ' "$1" >&2
  case "$1" in *SECRET*) stty -echo 2>/dev/null || true ;; esac
  IFS= read -r _ans || _ans=""
  case "$1" in *SECRET*) stty echo 2>/dev/null || true && printf '\n' >&2 ;; esac
  printf '%s' "$_ans"
}

# Takes the keys from the environment (or a prompt) into S3_SET_<name>, validated, and drops
# them from the environment so no child process inherits them. With a store already configured
# ($1 = yes) a key not given keeps its stored value; a pair is replaced only as a pair.
collect_s3_keys() {
  _missing=""
  for _pair in "S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY" "S3_EVIDENCE_ACCESS_KEY_ID S3_EVIDENCE_SECRET_ACCESS_KEY"; do
    _given=no
    for _k in $_pair; do
      eval "_v=\${$_k:-}"
      [ -z "$_v" ] || _given=yes
    done
    if [ "$_given" = no ] && [ "$1" = yes ]; then continue; fi
    for _k in $_pair; do
      eval "_v=\${$_k:-}"
      if [ -z "$_v" ]; then _v=$(prompt_s3_key "$_k") || _v=""; fi
      if [ -z "$_v" ]; then
        _missing="$_missing $_k"
        continue
      fi
      # Never the value in the message: it may be a secret pasted into the wrong variable.
      is_s3_key "$_v" || die "$_k is not an S3 key (3-256 of letters, digits and / + = . _ ~ -)"
      eval "S3_SET_$_k=\$_v"
    done
  done
  unset S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_EVIDENCE_ACCESS_KEY_ID S3_EVIDENCE_SECRET_ACCESS_KEY
  [ -z "$_missing" ] || die "an external object store needs its keys; missing:$_missing" \
    "fix: run install from a terminal, which asks for them (secrets without echo), or export them in" \
    "its environment; never as flags, which ps shows to every user. Both pairs are needed: the" \
    "evidence key may reach only the evidence bucket, the other key only the other three" \
    "(docs/self-hosting/object-storage.md)."
  _main=${S3_SET_S3_ACCESS_KEY_ID:-$(stored_s3 S3_ACCESS_KEY_ID)}
  _ev=${S3_SET_S3_EVIDENCE_ACCESS_KEY_ID:-$(stored_s3 S3_EVIDENCE_ACCESS_KEY_ID)}
  if [ "$_main" = "$_ev" ]; then
    die "S3_EVIDENCE_ACCESS_KEY_ID must be its own key, not S3_ACCESS_KEY_ID" \
      "fix: create a second key limited to the evidence bucket (ADR 0006 Q4, object-storage.md)"
  fi
}

# Refuses a flag that would repoint an external instance at other objects: a different endpoint
# or bucket leaves everything already stored behind, like a switch of mode would.
refuse_repoint() {
  _stored=$(stored_s3 "$1")
  if [ -n "$2" ] && [ -n "$_stored" ] && [ "$2" != "$_stored" ]; then
    die "this instance keeps its objects at $1=$_stored; $3 $2 would point it at other objects" \
      "selfhost.sh has no --migrate-objects: the objects already stored would stay behind." \
      "fix: drop $3 to keep the store, or copy every bucket to the new place first (rclone, as in" \
      "docs/self-hosting/backups.md, section 'Without the script') and install a new instance against it."
  fi
  return 0
}

# Decides the store for install: the current one on an existing instance, external when any
# --s3-* flag is given. Fills S3_SET_* for storage_env. Runs before anything is downloaded.
resolve_storage() {
  resolve_storage_settings
  [ "$STORAGE_MODE" = external ] || return 0
  collect_s3_keys "$STORAGE_STORED"
}

# The part of resolve_storage that needs no key: the mode, the endpoint and the buckets, checked
# against $ENV_FILE. cmd_install also runs it as root, before preparing the host.
resolve_storage_settings() {
  # The env file to check: the argument (root's precheck), else this run's.
  STORAGE_ENV=${1:-$ENV_FILE}
  STORAGE_STORED=no
  _have=""
  if [ -f "$STORAGE_ENV" ]; then
    read_storage_mode "$STORAGE_ENV"
    _have=$STORAGE_MODE
  fi
  if [ "$S3_FLAGS" = yes ]; then STORAGE_MODE=external; else STORAGE_MODE=${_have:-garage}; fi
  if [ -n "$_have" ] && [ "$_have" != "$STORAGE_MODE" ]; then
    die "this instance keeps its objects in Garage on this host; the --s3-* flags would move it to an external store" \
      "selfhost.sh has no --migrate-objects: the objects already stored would stay behind in Garage." \
      "fix: drop the --s3-* flags to keep Garage, or copy every bucket to the new store first (rclone, as in" \
      "docs/self-hosting/backups.md, section 'Without the script') and install a new instance against that store."
  fi
  [ "$STORAGE_MODE" = external ] || return 0
  [ "$_have" = external ] && STORAGE_STORED=yes
  refuse_repoint S3_ENDPOINT "$S3_OPT_ENDPOINT" --s3-endpoint
  refuse_repoint S3_BUCKET_MEDIA "$S3_OPT_BUCKET_MEDIA" --s3-bucket-media
  refuse_repoint S3_BUCKET_EXPORTS "$S3_OPT_BUCKET_EXPORTS" --s3-bucket-exports
  refuse_repoint S3_BUCKET_BACKUPS "$S3_OPT_BUCKET_BACKUPS" --s3-bucket-backups
  refuse_repoint S3_BUCKET_EVIDENCE "$S3_OPT_BUCKET_EVIDENCE" --s3-bucket-evidence
  S3_SET_ENDPOINT=${S3_OPT_ENDPOINT:-$(stored_s3 S3_ENDPOINT)}
  [ -n "$S3_SET_ENDPOINT" ] || die "--s3-endpoint is required for an external object store" \
    "e.g. --s3-endpoint https://nyc3.digitaloceanspaces.com --s3-region nyc3 (object-storage.md)"
  S3_SET_REGION=${S3_OPT_REGION:-$(stored_s3 S3_REGION)}
  [ -n "$S3_SET_REGION" ] || die "--s3-region is required with --s3-endpoint" \
    "the region the store signs requests for: nyc3 for Spaces in NYC3, us-east-1 for AWS's, garage for a Garage"
  S3_SET_PATH_STYLE=${S3_OPT_PATH_STYLE:-$(stored_s3 S3_FORCE_PATH_STYLE)}
  S3_SET_PATH_STYLE=${S3_SET_PATH_STYLE:-true}
  # A new endpoint without a public one means browsers use the new endpoint too.
  if [ -n "$S3_OPT_PUBLIC" ]; then
    S3_SET_PUBLIC=$S3_OPT_PUBLIC
  elif [ -n "$S3_OPT_ENDPOINT" ]; then
    S3_SET_PUBLIC=$S3_OPT_ENDPOINT
  else
    S3_SET_PUBLIC=$(stored_s3 S3_PUBLIC_ENDPOINT)
    S3_SET_PUBLIC=${S3_SET_PUBLIC:-$S3_SET_ENDPOINT}
  fi
  S3_SET_BUCKET_MEDIA=${S3_OPT_BUCKET_MEDIA:-$(stored_s3 S3_BUCKET_MEDIA)}
  S3_SET_BUCKET_MEDIA=${S3_SET_BUCKET_MEDIA:-commonair-media}
  S3_SET_BUCKET_EXPORTS=${S3_OPT_BUCKET_EXPORTS:-$(stored_s3 S3_BUCKET_EXPORTS)}
  S3_SET_BUCKET_EXPORTS=${S3_SET_BUCKET_EXPORTS:-commonair-exports}
  S3_SET_BUCKET_BACKUPS=${S3_OPT_BUCKET_BACKUPS:-$(stored_s3 S3_BUCKET_BACKUPS)}
  S3_SET_BUCKET_BACKUPS=${S3_SET_BUCKET_BACKUPS:-commonair-backups}
  S3_SET_BUCKET_EVIDENCE=${S3_OPT_BUCKET_EVIDENCE:-$(stored_s3 S3_BUCKET_EVIDENCE)}
  S3_SET_BUCKET_EVIDENCE=${S3_SET_BUCKET_EVIDENCE:-commonair-evidence}
  _n=$(printf '%s\n' "$S3_SET_BUCKET_MEDIA" "$S3_SET_BUCKET_EXPORTS" "$S3_SET_BUCKET_BACKUPS" "$S3_SET_BUCKET_EVIDENCE" |
    sort -u | wc -l | tr -d ' ')
  [ "$_n" -eq 4 ] || die "the media, exports, backups and evidence buckets must be four different buckets"
  return 0
}

# As root, before root_prepare: the same checks against the service user's env file, if it has
# one, so a refused store choice changes nothing on the host. Keys are left to the user's run.
# A symlinked env file is skipped (root does not follow links the service user controls); that
# run checks it anyway. A subshell keeps root's STORAGE_* and S3_SET_* as they were.
precheck_storage_as_root() {
  _env=/nonexistent
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    _uhome=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
    _cand="$_uhome/.config/commonair/commonair.env"
    if [ -n "$_uhome" ] && [ -f "$_cand" ] && [ ! -L "$_cand" ]; then _env=$_cand; fi
  fi
  (resolve_storage_settings "$_env") || exit 1
}

# Where browsers send presigned uploads: the public endpoint's origin, or with virtual-hosted
# URLs the media bucket's own host. Caddy's CSP connect-src allows it (S3_CONNECT_SRC).
s3_connect_src() {
  if [ "$S3_SET_PATH_STYLE" = true ]; then
    printf '%s' "$S3_SET_PUBLIC"
  else
    printf '%s://%s.%s' "${S3_SET_PUBLIC%%://*}" "$S3_SET_BUCKET_MEDIA" "${S3_SET_PUBLIC#*://}"
  fi
}

# Writes the store's settings to the env file. Garage: its in-network endpoint, which the units
# used to pin themselves. External: what resolve_storage decided (on upgrade, when it did not
# run, the env file already holds it).
storage_env() {
  if [ "$STORAGE_MODE" != external ]; then
    env_set S3_ENDPOINT "$GARAGE_S3_ENDPOINT"
    env_set S3_REGION garage
    env_set S3_FORCE_PATH_STYLE true
    return 0
  fi
  [ -n "${S3_SET_ENDPOINT:-}" ] || return 0
  env_set S3_MODE external
  env_set S3_ENDPOINT "$S3_SET_ENDPOINT"
  env_set S3_PUBLIC_ENDPOINT "$S3_SET_PUBLIC"
  env_set S3_REGION "$S3_SET_REGION"
  env_set S3_FORCE_PATH_STYLE "$S3_SET_PATH_STYLE"
  env_set S3_BUCKET_MEDIA "$S3_SET_BUCKET_MEDIA"
  env_set S3_BUCKET_EXPORTS "$S3_SET_BUCKET_EXPORTS"
  env_set S3_BUCKET_BACKUPS "$S3_SET_BUCKET_BACKUPS"
  env_set S3_BUCKET_EVIDENCE "$S3_SET_BUCKET_EVIDENCE"
  env_set S3_CONNECT_SRC "$(s3_connect_src)"
  for _k in $S3_KEY_VARS; do
    eval "_v=\${S3_SET_$_k:-}"
    if [ -n "$_v" ]; then env_set "$_k" "$_v"; fi
  done
  info "object storage: the external store at $S3_SET_ENDPOINT (create its buckets and CORS first: object-storage.md)"
}

# For status: each bucket of an external store, listed with the instance's keys by storage-init
# in the tools image. The keys reach it in a 0600 env file rendered like the unit's own, never on
# a command line, and it prints no key.
storage_check() {
  make_tmp
  _f="$TMP_ROOT/storage-check.env"
  if ! sh "$CURRENT_LINK/scripts/selfhost/render-env.sh" "$CURRENT_LINK/infra/selfhost/env/commonair-storage-init.keys" \
    "$ENV_FILE" "$_f" 2>/dev/null; then
    say "  (cannot read the store's settings from $ENV_FILE)"
    return 0
  fi
  _rc=0
  _out=$(podman run --rm --network commonair --env-file "$_f" "$(tools_image "$CURRENT_LINK")" \
    bun infra/garage/storage-init.ts --check 2>&1) || _rc=$?
  rm -f "$_f"
  printf '%s\n' "$_out" | sed 's/^/  /'
  if [ "$_rc" -ne 0 ]; then say "  the store is NOT ready (journalctl --user -u commonair-storage-init)"; fi
  return 0
}

# --- Postgres and Valkey: bundled (the default) or external ---------------------------------
#
# STATE_MODE in commonair.env says where the database and Valkey run. Unset (or bundled), the
# default: commonair-postgres (with WAL-G) and commonair-valkey on this host, exactly as before.
# `external`: an operator's servers, chosen with --database-url and --valkey-url on install, a
# managed service such as DigitalOcean's (ADR 0032 §3, docs/self-hosting/managed-services.md).
# Then install_units leaves both units out and renders the others without edges to them, migrate
# runs as the operator's owner role (CREATEROLE, no superuser) and creates the app and monitor
# roles, and each unit whose key list names DATABASE_CA_FILE or VALKEY_CA_FILE mounts the CA's
# secret where that key points. The owner's and Valkey's passwords are never flags and never in
# commonair.env: only in Podman secrets. Only external mode writes STATE_MODE, and an instance never
# switches: moving the data is a dump and restore, which selfhost.sh does not do in place.

STATE_MODE=bundled
STATE_DOC="docs/self-hosting/managed-services.md, section 'Moving between bundled and managed services'"
STATE_PG_CA_SECRET=commonair-pg-ca
STATE_VK_CA_SECRET=commonair-valkey-ca
STATE_PG_CA_PATH=/run/secrets/commonair-pg-ca
STATE_VK_CA_PATH=/run/secrets/commonair-valkey-ca
# A host name, an IPv4 address or an IPv6 literal in brackets, then an optional port.
STATE_HOST_RE='([A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(:[0-9]{1,5})?'
# The URLs carry a user and a host, never a password (it would be in ps and in commonair.env).
STATE_PG_URL_RE="^postgres(ql)?://[A-Za-z0-9._~%-]{1,63}@$STATE_HOST_RE/[A-Za-z0-9_.~%-]{1,63}(\\?sslmode=(disable|allow|prefer|require|verify-ca|verify-full))?\$"
STATE_VK_URL_RE="^rediss?://([A-Za-z0-9._~%-]{1,63}@)?$STATE_HOST_RE(/[0-9]{1,2})?\$"

# Percent-encodes $1 for a URL's user-info (RFC 3986: all but the unreserved characters), byte by
# byte (LC_ALL=C). The value reaches awk through its environment, never its argv.
url_encode() {
  SELFHOST_VALUE="$1" LC_ALL=C awk 'BEGIN {
    for (i = 1; i < 256; i++) ord[sprintf("%c", i)] = i
    v = ENVIRON["SELFHOST_VALUE"]
    out = ""
    for (i = 1; i <= length(v); i++) {
      c = substr(v, i, 1)
      if (c ~ /^[A-Za-z0-9._~-]$/) out = out c
      else out = out sprintf("%%%02X", ord[c])
    }
    printf "%s", out
  }'
}

# Parts of a validated URL: the scheme, the user, what follows the user-info (host, port, path
# and query), host[:port], the host with its port (a default one added), the sslmode.
url_scheme() { printf '%s' "${1%%://*}"; }
url_user() {
  _uu=${1#*://}
  case "$_uu" in *@*) printf '%s' "${_uu%%@*}" ;; esac
}
url_after_user() {
  _ua=${1#*://}
  printf '%s' "${_ua#*@}"
}
url_hostport() {
  _uh=$(url_after_user "$1")
  printf '%s' "${_uh%%/*}"
}
url_endpoint() {
  _ue=$(url_hostport "$1")
  case "$_ue" in
    \[*\]:* | [!\[]*:*) printf '%s' "$_ue" ;;
    *) printf '%s:%s' "$_ue" "$2" ;;
  esac
}
url_sslmode() {
  case "$1" in *\?sslmode=*) printf '%s' "${1##*sslmode=}" ;; *) printf 'prefer' ;; esac
}
# Where a database's data lives: host, port and database, not the user (an owner may rotate).
pg_place() {
  _pp=$(url_after_user "$1")
  printf '%s/%s' "$(url_endpoint "$1" 5432)" "${_pp#*/}" | sed 's/?.*//'
}

# A URL with $2 (already encoded) as the password of its user.
url_with_password() {
  printf '%s://%s:%s@%s' "$(url_scheme "$1")" "$(url_user "$1")" "$2" "$(url_after_user "$1")"
}

# The owner's URL and Valkey's, with the passwords this run was given.
owner_url_with_password() { url_with_password "$STATE_SET_DB_URL" "$(url_encode "$STATE_SET_DB_PW")"; }
valkey_url_with_password() { url_with_password "$STATE_SET_VK_URL" "$(url_encode "$STATE_SET_VK_PW")"; }
# The app role's URL on the same server and database (its password is init-env's, in the env file).
app_database_url() {
  printf 'postgres://commonair_app:%s@%s' "$(url_encode "$(env_get POSTGRES_APP_PASSWORD "$ENV_FILE")")" \
    "$(url_after_user "$STATE_SET_DB_URL")"
}

# A CA file: readable PEM certificates, nothing else.
check_ca_file() {
  [ -f "$2" ] && [ -r "$2" ] || die "$1: no such readable file: $2"
  if grep -q 'PRIVATE KEY' "$2"; then
    die "$1 $2 holds a private key: refusing it" "fix: pass the CA certificate only (-----BEGIN CERTIFICATE-----), never a key"
  fi
  grep -q -e '-----BEGIN CERTIFICATE-----' "$2" ||
    die "$1 $2 is not a PEM certificate (no -----BEGIN CERTIFICATE----- line)" \
      "fix: pass the CA in PEM form (DigitalOcean's 'Download CA certificate' is); convert DER with: openssl x509 -inform der -in ca.der -out ca.pem"
}

# The flags, checked as parse_flags reads them (as root too, before anything happens).
check_state_flags() {
  if [ -n "$DB_OPT_URL" ]; then
    case "$DB_OPT_URL" in
      *://*:*@* | *://*@*@*)
        die "--database-url holds a password: refusing it, since every user on this host can read a command line (ps)" \
          "fix: --database-url postgres://<user>@<host>:<port>/<database>?sslmode=verify-full, and the password in" \
          "DATABASE_PASSWORD in install's environment, or run install from a terminal, which asks for it"
        ;;
    esac
    printf '%s' "$DB_OPT_URL" | grep -Eq "$STATE_PG_URL_RE" ||
      die "not a database URL: --database-url must be postgres://<user>@<host>[:<port>]/<database>?sslmode=verify-full" \
        "(the user and database percent-encoded, an IPv6 host in brackets; sslmode is the only parameter)"
    _ssl=$(url_sslmode "$DB_OPT_URL")
    if [ "$_ssl" != verify-full ] && [ "$DB_ALLOW_INSECURE" != yes ]; then
      die "--database-url says sslmode=$_ssl: the server's certificate and name would not be verified" \
        "fix: end the URL with ?sslmode=verify-full (and --database-ca <file> for a private CA), or pass" \
        "--allow-insecure-database for a server on a private network only"
    fi
    # The metrics collector speaks three modes (contract §3.7): verify-full, require (TLS without
    # verification) and disable. The others are libpq's in-betweens, refused rather than guessed.
    case "$_ssl" in
      verify-full | require | disable) ;;
      *)
        die "--database-url says sslmode=$_ssl, which selfhost.sh does not take" \
          "fix: sslmode=verify-full; or, with --allow-insecure-database on a private network only," \
          "sslmode=require (TLS, the certificate not verified) or sslmode=disable (no TLS)"
        ;;
    esac
    if [ -n "$DB_OPT_CA" ] && [ "$_ssl" != verify-full ]; then
      die "--database-ca is used with sslmode=verify-full only, and the URL says sslmode=$_ssl"
    fi
  fi
  if [ -n "$VK_OPT_URL" ]; then
    case "$VK_OPT_URL" in
      *://*:*@* | *://*@*@*)
        die "--valkey-url holds a password: refusing it, since every user on this host can read a command line (ps)" \
          "fix: --valkey-url rediss://[<user>@]<host>:<port>, and the password in VALKEY_PASSWORD in install's" \
          "environment, or run install from a terminal, which asks for it"
        ;;
    esac
    printf '%s' "$VK_OPT_URL" | grep -Eq "$STATE_VK_URL_RE" ||
      die "not a Valkey URL: --valkey-url must be rediss://[<user>@]<host>[:<port>][/<db>] (an IPv6 host in brackets)"
    case "$VK_OPT_URL" in
      redis://*)
        [ "$VK_ALLOW_INSECURE" = yes ] || die "--valkey-url is redis://, without TLS: Valkey's password and every job would cross the network in the clear" \
          "fix: use rediss:// (and --valkey-ca <file> for a private CA), or pass --allow-insecure-valkey for a server on a private network only"
        [ -z "$VK_OPT_CA" ] || die "--valkey-ca is used with rediss:// only"
        ;;
    esac
  fi
  if [ "$DB_ALLOW_INSECURE" = yes ] && [ -z "$DB_OPT_URL" ]; then die "--allow-insecure-database goes with --database-url"; fi
  if [ "$VK_ALLOW_INSECURE" = yes ] && [ -z "$VK_OPT_URL" ]; then die "--allow-insecure-valkey goes with --valkey-url"; fi
  # "system": verify against the system's trusted CAs, dropping a CA install recorded.
  if [ -n "$DB_OPT_CA" ] && [ "$DB_OPT_CA" != system ]; then check_ca_file --database-ca "$DB_OPT_CA"; fi
  if [ -n "$VK_OPT_CA" ] && [ "$VK_OPT_CA" != system ]; then check_ca_file --valkey-ca "$VK_OPT_CA"; fi
  return 0
}

refuse_state_switch() {
  if [ "$1" = bundled ]; then
    _from="the bundled Postgres and Valkey on this host (bundled)"
    _to="external servers (--database-url, --valkey-url)"
  else
    _from="external Postgres and Valkey (external, $(pg_place "$(env_get DATABASE_OWNER_URL "$STATE_ENV")"))"
    _to="the bundled ones (STATE_MODE=external is missing from $STATE_ENV)"
  fi
  die "this instance keeps its database and Valkey in $_from; this run asks for $_to" \
    "moving between bundled and external Postgres and Valkey is a data migration, not a flag, and" \
    "selfhost.sh refuses to switch in place. Nothing was changed." \
    "fix: drop the flags (or restore the STATE_MODE line) to keep what is there, or follow the dump and" \
    "restore procedure in $STATE_DOC."
}

# Sets STATE_MODE from an env file; refuses one that names external servers without saying so.
read_state_mode() {
  STATE_ENV=$1
  _sm=$(env_get STATE_MODE "$1")
  case "$_sm" in
    "" | bundled)
      STATE_MODE=bundled
      if [ -n "$(env_get DATABASE_OWNER_URL "$1")" ]; then refuse_state_switch external bundled; fi
      ;;
    external) STATE_MODE=external ;;
    *) die "STATE_MODE=$_sm in $1 is neither bundled nor external" "fix: correct the line (an instance keeps the Postgres and Valkey it was installed with)" ;;
  esac
}

# The part of the choice that needs no password: the mode, the URLs, the insecure flags, checked
# against the env file ($1 for root's precheck). Runs before anything is downloaded.
resolve_state_settings() {
  STATE_ENV=${1:-$ENV_FILE}
  _have=""
  if [ -f "$STATE_ENV" ]; then
    read_state_mode "$STATE_ENV"
    _have=$STATE_MODE
  fi
  if [ -n "$DB_OPT_URL$VK_OPT_URL" ]; then STATE_MODE=external; else STATE_MODE=${_have:-bundled}; fi
  if [ -n "$_have" ] && [ "$_have" != "$STATE_MODE" ]; then refuse_state_switch "$_have" "$STATE_MODE"; fi
  if [ "$STATE_MODE" != external ]; then
    [ -z "$DB_OPT_CA$VK_OPT_CA" ] || die "--database-ca and --valkey-ca apply to external Postgres and Valkey only (--database-url, --valkey-url)"
    return 0
  fi
  _sdb=""
  _svk=""
  if [ "$_have" = external ]; then
    _sdb=$(env_get DATABASE_OWNER_URL "$STATE_ENV")
    _svk=$(env_get VALKEY_URL "$STATE_ENV")
  fi
  STATE_SET_DB_URL=${DB_OPT_URL:-$_sdb}
  STATE_SET_VK_URL=${VK_OPT_URL:-$_svk}
  if [ -z "$STATE_SET_DB_URL" ] || [ -z "$STATE_SET_VK_URL" ]; then
    die "external state needs both servers: --database-url and --valkey-url go together" \
      "(the bundled Postgres and Valkey are the default: give neither for them)"
  fi
  if [ -n "$DB_OPT_URL" ] && [ -n "$_sdb" ] && [ "$(pg_place "$DB_OPT_URL")" != "$(pg_place "$_sdb")" ]; then
    die "this instance keeps its database at $(pg_place "$_sdb"); --database-url would point it at $(pg_place "$DB_OPT_URL")" \
      "its data would stay behind: selfhost.sh moves no database. Nothing was changed." \
      "fix: drop --database-url (a new owner user on the same server and database is fine), or dump and" \
      "restore into the new server first ($STATE_DOC) and install a new instance against it."
  fi
  if [ -n "$VK_OPT_URL" ] && [ -n "$_svk" ] && [ "$VK_OPT_URL" != "$_svk" ]; then
    warn "Valkey moves from $(url_endpoint "$_svk" 6379) to $(url_endpoint "$VK_OPT_URL" 6379): queued jobs, sessions and caches on the old one are not carried over"
  fi
  # A new URL takes the flags given with it; otherwise what install recorded.
  if [ -n "$DB_OPT_URL" ]; then
    STATE_SET_DB_INSECURE=$DB_ALLOW_INSECURE
  elif [ "$(env_get DATABASE_ALLOW_INSECURE "$STATE_ENV")" = true ]; then
    STATE_SET_DB_INSECURE=yes
  else
    STATE_SET_DB_INSECURE=no
  fi
  if [ -n "$VK_OPT_URL" ]; then
    STATE_SET_VK_INSECURE=$VK_ALLOW_INSECURE
  elif [ "$(env_get VALKEY_ALLOW_INSECURE "$STATE_ENV")" = true ]; then
    STATE_SET_VK_INSECURE=yes
  else
    STATE_SET_VK_INSECURE=no
  fi
  if [ "$STATE_SET_DB_INSECURE" = yes ]; then
    warn "--allow-insecure-database: the database's certificate is not verified (sslmode=$(url_sslmode "$STATE_SET_DB_URL")); use it on a private network only"
  fi
  if [ "$STATE_SET_VK_INSECURE" = yes ]; then
    case "$STATE_SET_VK_URL" in redis://*) warn "--allow-insecure-valkey: Valkey's password and every job cross the network without TLS; use it on a private network only" ;; esac
  fi
  if [ -n "$DB_OPT_CA" ] && [ "$(url_sslmode "$STATE_SET_DB_URL")" != verify-full ]; then
    die "--database-ca is used with sslmode=verify-full only, and $STATE_ENV's DATABASE_OWNER_URL says sslmode=$(url_sslmode "$STATE_SET_DB_URL")"
  fi
  case "$STATE_SET_VK_URL" in redis://*) [ -z "$VK_OPT_CA" ] || die "--valkey-ca is used with rediss:// only" ;; esac
  return 0
}

# As root, before root_prepare: the same checks against the service user's env file, so a refused
# choice changes nothing on the host (as precheck_storage_as_root; a subshell keeps root's state).
precheck_state_as_root() {
  _env=/nonexistent
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    _uhome=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
    _cand="$_uhome/.config/commonair/commonair.env"
    if [ -n "$_uhome" ] && [ -f "$_cand" ] && [ ! -L "$_cand" ]; then _env=$_cand; fi
  fi
  (resolve_state_settings "$_env") || exit 1
}

secret_exists() { podman secret exists "$1" >/dev/null 2>&1; }

# Asks on the terminal (passwords without echo). Fails without a terminal.
prompt_state() {
  [ -t 0 ] || return 1
  printf 'selfhost: %s: ' "$1" >&2
  case "$1" in *PASSWORD*) stty -echo 2>/dev/null || true ;; esac
  IFS= read -r _ans || _ans=""
  case "$1" in *PASSWORD*) stty echo 2>/dev/null || true && printf '\n' >&2 ;; esac
  printf '%s' "$_ans"
}

# A password from the environment ($1), else the terminal, when $2 = yes (needed) or it is given.
state_password() {
  eval "_spv=\${$1:-}"
  if [ -z "$_spv" ] && [ "$2" = yes ]; then _spv=$(prompt_state "$1") || _spv=""; fi
  case "$_spv" in
    *"
"*) die "$1 holds a line break" ;;
  esac
  [ "${#_spv}" -le 1024 ] || die "$1 is longer than 1024 characters"
  printf '%s' "$_spv"
}

# The secrets external state needs that this run must supply: each password when the URL is new
# or its secret is missing (the environment wins over a stored one), each CA when the flag gives
# one or the env file uses one whose secret is gone (never dropping TLS without a word).
collect_state_secrets() {
  STATE_SET_DB_PW=""
  STATE_SET_VK_PW=""
  STATE_SET_DB_CA=""
  STATE_SET_VK_CA=""
  [ "$STATE_MODE" = external ] || return 0
  _dbn=no
  _vkn=no
  if [ -n "$DB_OPT_URL" ] || ! secret_exists commonair-owner-database-url; then _dbn=yes; fi
  if [ -n "$VK_OPT_URL" ] || ! secret_exists commonair-valkey-url || ! secret_exists commonair-valkey-monitor-password; then
    _vkn=yes
  fi
  STATE_SET_DB_PW=$(state_password DATABASE_PASSWORD "$_dbn")
  STATE_SET_VK_PW=$(state_password VALKEY_PASSWORD "$_vkn")
  # No child process inherits them from here on.
  unset DATABASE_PASSWORD VALKEY_PASSWORD
  _miss=""
  if [ "$_dbn" = yes ] && [ -z "$STATE_SET_DB_PW" ]; then _miss="$_miss DATABASE_PASSWORD"; fi
  if [ "$_vkn" = yes ] && [ -z "$STATE_SET_VK_PW" ]; then _miss="$_miss VALKEY_PASSWORD"; fi
  [ -z "$_miss" ] || die "external Postgres and Valkey need their passwords; missing:$_miss" \
    "fix: run selfhost.sh from a terminal, which asks for them (without echo), or export them in its" \
    "environment; never as flags or in the URL, which ps shows to every user. They are kept in Podman" \
    "secrets only, so later upgrades need them again only if a secret is removed."
  if [ "$DB_OPT_CA" = system ]; then
    STATE_SET_DB_CA=""
  elif [ -n "$DB_OPT_CA" ]; then
    STATE_SET_DB_CA=$DB_OPT_CA
  elif state_pg_ca_on && ! secret_exists "$STATE_PG_CA_SECRET"; then
    STATE_SET_DB_CA=$(prompt_state "the Postgres CA file (the secret $STATE_PG_CA_SECRET is gone)") || STATE_SET_DB_CA=""
    [ -n "$STATE_SET_DB_CA" ] || die "the Podman secret $STATE_PG_CA_SECRET is missing, and the database is verified against it" \
      "fix: re-run with --database-ca <file> (the CA that signed the server's certificate), or from a terminal, which asks for it"
    check_ca_file "the Postgres CA" "$STATE_SET_DB_CA"
  fi
  if [ "$VK_OPT_CA" = system ]; then
    STATE_SET_VK_CA=""
  elif [ -n "$VK_OPT_CA" ]; then
    STATE_SET_VK_CA=$VK_OPT_CA
  elif state_vk_ca_on && ! secret_exists "$STATE_VK_CA_SECRET"; then
    STATE_SET_VK_CA=$(prompt_state "the Valkey CA file (the secret $STATE_VK_CA_SECRET is gone)") || STATE_SET_VK_CA=""
    [ -n "$STATE_SET_VK_CA" ] || die "the Podman secret $STATE_VK_CA_SECRET is missing, and Valkey is verified against it" \
      "fix: re-run with --valkey-ca <file> (the CA that signed Valkey's certificate), or from a terminal, which asks for it"
    check_ca_file "the Valkey CA" "$STATE_SET_VK_CA"
  fi
  return 0
}

# Whether each server's certificate is verified: the URL this run uses, else the one install recorded.
state_pg_verified() {
  [ "$(url_sslmode "${STATE_SET_DB_URL:-$(env_get DATABASE_OWNER_URL "$ENV_FILE")}")" = verify-full ]
}
state_vk_verified() {
  case "${STATE_SET_VK_URL:-$(env_get VALKEY_URL "$ENV_FILE")}" in rediss://*) return 0 ;; *) return 1 ;; esac
}

# Whether the services verify against a CA of ours: one given now, or one install recorded, and
# only while the URL verifies at all (a CA with sslmode=require would stop every service:
# packages/db refuses that pairing) and --*-ca system did not drop it for the system's CAs.
state_pg_ca_on() {
  state_pg_verified && [ "${DB_OPT_CA:-}" != system ] &&
    { [ -n "${STATE_SET_DB_CA:-}" ] || [ -n "$(env_get DATABASE_CA_FILE "$ENV_FILE")" ]; }
}
state_vk_ca_on() {
  state_vk_verified && [ "${VK_OPT_CA:-}" != system ] &&
    { [ -n "${STATE_SET_VK_CA:-}" ] || [ -n "$(env_get VALKEY_CA_FILE "$ENV_FILE")" ]; }
}

# DATABASE_POOL_MAX: install's environment (the preflight's fix says so), else the env file's.
state_pool_max() {
  _pm=${DATABASE_POOL_MAX:-$(env_get DATABASE_POOL_MAX "$ENV_FILE")}
  _pm=${_pm:-10}
  printf '%s' "$_pm" | grep -Eq '^[1-9][0-9]{0,3}$' || die "DATABASE_POOL_MAX must be a whole number from 1 to 9999, not $_pm"
  printf '%s' "$_pm"
}

# Runs infra/selfhost/state-check.ts ($2: preflight or status) in release $1's tools image. The
# passwords reach it only through podman's environment (--env NAME, no value on the command line)
# or as the stored secrets; a new CA as a read-only mount of a copy, a stored one as its secret.
state_check_run() {
  make_tmp
  _sc_rel=$1
  _sc_mode=$2
  _sc_dir="$TMP_ROOT/state-check"
  rm -rf "$_sc_dir"
  mkdir -p "$_sc_dir"
  chmod 755 "$_sc_dir"
  _sc_pg=""
  _sc_vk=""
  _sc_net=""
  if ! podman network exists commonair >/dev/null 2>&1; then
    _sc_net=$(preflight_network "$_sc_rel") || return 1
  fi
  # The route the services will take: the instance's network, or (first install) a stand-in.
  set -- run --rm --network "${_sc_net:-commonair}"
  if [ "$_sc_mode" = status ]; then
    # The app role is enough to read the version and the connection count.
    set -- "$@" --secret "commonair-database-url,type=env,target=STATE_PG_URL" \
      --secret "commonair-valkey-url,type=env,target=STATE_VALKEY_URL"
  else
    if [ -n "$STATE_SET_DB_PW" ]; then
      _sc_pg=$(owner_url_with_password)
      set -- "$@" --env STATE_PG_URL
    else
      set -- "$@" --secret "commonair-owner-database-url,type=env,target=STATE_PG_URL"
    fi
    if [ -n "$STATE_SET_VK_PW" ]; then
      _sc_vk=$(valkey_url_with_password)
      set -- "$@" --env STATE_VALKEY_URL
    else
      set -- "$@" --secret "commonair-valkey-url,type=env,target=STATE_VALKEY_URL"
    fi
  fi
  if [ -n "${STATE_SET_DB_CA:-}" ]; then
    cp "$STATE_SET_DB_CA" "$_sc_dir/pg-ca.pem"
    set -- "$@" -e STATE_PG_CA=/run/state-check/pg-ca.pem
  elif state_pg_ca_on; then
    set -- "$@" --secret "$STATE_PG_CA_SECRET,type=mount,target=$STATE_PG_CA_PATH,mode=0444" -e "STATE_PG_CA=$STATE_PG_CA_PATH"
  fi
  if [ -n "${STATE_SET_VK_CA:-}" ]; then
    cp "$STATE_SET_VK_CA" "$_sc_dir/valkey-ca.pem"
    set -- "$@" -e STATE_VALKEY_CA=/run/state-check/valkey-ca.pem
  elif state_vk_ca_on; then
    set -- "$@" --secret "$STATE_VK_CA_SECRET,type=mount,target=$STATE_VK_CA_PATH,mode=0444" -e "STATE_VALKEY_CA=$STATE_VK_CA_PATH"
  fi
  chmod 644 "$_sc_dir"/* 2>/dev/null || true
  # What this run decided, else (status) what install recorded.
  _sc_dbi=${STATE_SET_DB_INSECURE:-$(env_get DATABASE_ALLOW_INSECURE "$ENV_FILE")}
  _sc_vki=${STATE_SET_VK_INSECURE:-$(env_get VALKEY_ALLOW_INSECURE "$ENV_FILE")}
  case "$_sc_dbi" in yes | true) set -- "$@" -e STATE_ALLOW_INSECURE_DATABASE=true ;; esac
  case "$_sc_vki" in yes | true) set -- "$@" -e STATE_ALLOW_INSECURE_VALKEY=true ;; esac
  set -- "$@" -e "STATE_POOL_MAX=$(state_pool_max)" -v "$_sc_dir:/run/state-check:ro,Z" \
    "$(tools_image "$_sc_rel")" bun infra/selfhost/state-check.ts "$_sc_mode"
  _sc_rc=0
  STATE_PG_URL=$_sc_pg STATE_VALKEY_URL=$_sc_vk podman "$@" || _sc_rc=$?
  rm -rf "$_sc_dir"
  if [ -n "$_sc_net" ]; then podman network rm "$_sc_net" >/dev/null 2>&1 || true; fi
  return "$_sc_rc"
}

# Before the first install the commonair network does not exist yet, and Podman's default (pasta
# for a rootless run) is not the route the services take. A throwaway bridge network with the
# release's subnet (quadlet/commonair.network) is, the same way; the caller removes it, so the
# preflight still leaves nothing behind, and commonair-network.service creates the real one.
preflight_network() {
  _pn_file="$1/quadlet/commonair.network"
  _pn_subnet=$(sed -n 's/^Subnet=//p' "$_pn_file" 2>/dev/null | head -n 1)
  _pn_range=$(sed -n 's/^IPRange=//p' "$_pn_file" 2>/dev/null | head -n 1)
  [ -n "$_pn_subnet" ] && [ -n "$_pn_range" ] || { warn "no Subnet= or IPRange= in $_pn_file"; return 1; }
  _pn_name="commonair-preflight-$$"
  podman network create --subnet "$_pn_subnet" --ip-range "$_pn_range" "$_pn_name" >/dev/null ||
    { warn "could not create the preflight's network $_pn_name ($_pn_subnet)"; return 1; }
  printf '%s' "$_pn_name"
}

# Before anything is installed or changed: TLS, the owner's rights, the version, the connection
# budget and Valkey's eviction policy (infra/selfhost/state-check.ts). Read only.
state_preflight() {
  [ "$STATE_MODE" = external ] || return 0
  info "checking the external Postgres and Valkey (preflight: nothing is changed yet)"
  _pf_rc=0
  _pf_out=$(state_check_run "$1" preflight 2>&1) || _pf_rc=$?
  printf '%s\n' "$_pf_out" | sed 's/^/  /' >&2
  [ "$_pf_rc" -eq 0 ] || die "the external Postgres or Valkey failed the preflight; nothing was installed or changed" \
    "fix: what the fix: lines above say, then re-run (docs/self-hosting/requirements.md, 'External Postgres and Valkey')"
}

# For status: each server's reachability, TLS, version and load, from the tools image, as unit rows.
state_status() {
  _ss_out=$(state_check_run "$CURRENT_LINK" status 2>&1) || true
  printf '%s\n' "$_ss_out" | while IFS= read -r _l; do
    case "$_l" in
      "postgres "*) printf '  %-34s %-10s %s\n' commonair-postgres external "$(printf '%s' "${_l#postgres}" | sed 's/^ *//')" ;;
      "valkey "*) printf '  %-34s %-10s %s\n' commonair-valkey external "$(printf '%s' "${_l#valkey}" | sed 's/^ *//')" ;;
      "") ;;
      *) printf '  %s\n' "$_l" ;;
    esac
  done
}

# The env file's view of Postgres and Valkey: external mode's URLs and switches, and in both modes
# the metrics collector's keys (contract §3.7) and the monitor role's password, which migrate
# reads (POSTGRES_MONITOR_PASSWORD; generated once, kept).
state_env() {
  if [ -z "$(env_get POSTGRES_MONITOR_PASSWORD "$ENV_FILE")" ]; then
    env_set POSTGRES_MONITOR_PASSWORD "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
  fi
  env_set PG_MONITOR_USER commonair_monitor
  if [ "$STATE_MODE" != external ]; then
    env_set PG_MONITOR_ENDPOINT postgres:5432
    env_set PG_MONITOR_TLS disable
    env_set VALKEY_MONITOR_ENDPOINT valkey:6379
    env_set VALKEY_MONITOR_USER ""
    env_set VALKEY_MONITOR_TLS off
    env_set OBSERVABILITY_STATE_MODE bundled
    return 0
  fi
  env_set STATE_MODE external
  env_set DATABASE_OWNER_URL "$STATE_SET_DB_URL"
  env_set DATABASE_URL "$(app_database_url)"
  # Without its password, which only the Podman secret commonair-valkey-url holds.
  env_set VALKEY_URL "$STATE_SET_VK_URL"
  if state_pg_ca_on; then env_set DATABASE_CA_FILE "$STATE_PG_CA_PATH"; else env_set DATABASE_CA_FILE ""; fi
  if state_vk_ca_on; then env_set VALKEY_CA_FILE "$STATE_VK_CA_PATH"; else env_set VALKEY_CA_FILE ""; fi
  if [ "$STATE_SET_DB_INSECURE" = yes ]; then env_set DATABASE_ALLOW_INSECURE true; else env_set DATABASE_ALLOW_INSECURE false; fi
  if [ "$STATE_SET_VK_INSECURE" = yes ]; then env_set VALKEY_ALLOW_INSECURE true; else env_set VALKEY_ALLOW_INSECURE false; fi
  if [ -n "${DATABASE_POOL_MAX:-}" ]; then env_set DATABASE_POOL_MAX "$(state_pool_max)"; fi
  env_set PG_MONITOR_ENDPOINT "$(url_endpoint "$STATE_SET_DB_URL" 5432)"
  # verify-full, or with --allow-insecure-database require or disable (check_state_flags).
  env_set PG_MONITOR_TLS "$(url_sslmode "$STATE_SET_DB_URL")"
  env_set VALKEY_MONITOR_ENDPOINT "$(url_endpoint "$STATE_SET_VK_URL" 6379)"
  # The instance's own Valkey user (empty: the default user); no other exists without ACL.
  _vmu=$(url_user "$STATE_SET_VK_URL")
  [ "$_vmu" != default ] || _vmu=""
  env_set VALKEY_MONITOR_USER "$_vmu"
  case "$STATE_SET_VK_URL" in rediss://*) env_set VALKEY_MONITOR_TLS on ;; *) env_set VALKEY_MONITOR_TLS off ;; esac
  env_set OBSERVABILITY_STATE_MODE external
  info "postgres: external, $(url_user "$STATE_SET_DB_URL")@$(pg_place "$STATE_SET_DB_URL"); valkey: external, $(url_endpoint "$STATE_SET_VK_URL" 6379)"
}

# External state's secrets. The app role's URL is rebuilt every time (its password is init-env's);
# the owner's and Valkey's only when this run has the password, else the stored ones stay.
state_secrets() {
  printf '%s' "$(app_database_url)" | podman secret create --replace commonair-database-url - >/dev/null
  if [ -n "$STATE_SET_DB_PW" ]; then
    printf '%s' "$(owner_url_with_password)" | podman secret create --replace commonair-owner-database-url - >/dev/null
  fi
  printf '%s' "$2" | podman secret create --replace commonair-grafana-admin-password - >/dev/null
  if [ -n "$STATE_SET_VK_PW" ]; then
    printf '%s' "$(valkey_url_with_password)" | podman secret create --replace commonair-valkey-url - >/dev/null
    printf '%s' "$STATE_SET_VK_PW" | podman secret create --replace commonair-valkey-monitor-password - >/dev/null
  fi
  monitor_password_secret
  if [ -n "$STATE_SET_DB_CA" ]; then podman secret create --replace "$STATE_PG_CA_SECRET" - <"$STATE_SET_DB_CA" >/dev/null; fi
  if [ -n "$STATE_SET_VK_CA" ]; then podman secret create --replace "$STATE_VK_CA_SECRET" - <"$STATE_SET_VK_CA" >/dev/null; fi
  # A CA no unit mounts any more (--*-ca system, or a URL that no longer verifies).
  if [ "$STATE_MODE" = external ] && ! state_pg_ca_on && secret_exists "$STATE_PG_CA_SECRET"; then
    podman secret rm "$STATE_PG_CA_SECRET" >/dev/null 2>&1 || true
  fi
  if [ "$STATE_MODE" = external ] && ! state_vk_ca_on && secret_exists "$STATE_VK_CA_SECRET"; then
    podman secret rm "$STATE_VK_CA_SECRET" >/dev/null 2>&1 || true
  fi
  return 0
}

# Copies release unit $2 into the Quadlet directory. With external state a container unit loses
# every dependency edge to the bundled Postgres and Valkey units (none is installed), and one whose
# key list names DATABASE_CA_FILE or VALKEY_CA_FILE mounts that CA's secret at the path the key
# points to. Bundled: the release's file, byte for byte.
install_unit_file() {
  _iu=$(basename "$2")
  if [ "${_iu##*.}" != container ]; then
    cp "$2" "$QUADLET_DIR/"
    return 0
  fi
  _keys="$1/infra/selfhost/env/${_iu%.container}.keys"
  _pgca=""
  _vkca=""
  if state_pg_ca_on && [ -f "$_keys" ] && grep -qx DATABASE_CA_FILE "$_keys"; then _pgca="$STATE_PG_CA_SECRET,type=mount,target=$STATE_PG_CA_PATH,mode=0444"; fi
  if state_vk_ca_on && [ -f "$_keys" ] && grep -qx VALKEY_CA_FILE "$_keys"; then _vkca="$STATE_VK_CA_SECRET,type=mount,target=$STATE_VK_CA_PATH,mode=0444"; fi
  SELFHOST_PGCA=$_pgca SELFHOST_VKCA=$_vkca awk '
    BEGIN { pg = ENVIRON["SELFHOST_PGCA"]; vk = ENVIRON["SELFHOST_VKCA"] }
    /^(Wants|Requires|Requisite|BindsTo|PartOf|Upholds|After|Before)=/ {
      key = substr($0, 1, index($0, "=") - 1)
      n = split(substr($0, index($0, "=") + 1), names, /[ \t]+/)
      kept = ""
      for (i = 1; i <= n; i++)
        if (names[i] != "" && names[i] != "commonair-postgres.service" && names[i] != "commonair-valkey.service")
          kept = kept (kept == "" ? "" : " ") names[i]
      if (kept != "") print key "=" kept
      next
    }
    { print }
    /^\[Container\]$/ {
      if (pg != "" || vk != "") print "# selfhost.sh, external state: the CA the client verifies the server against."
      if (pg != "") print "Secret=" pg
      if (vk != "") print "Secret=" vk
    }
  ' "$2" >"$QUADLET_DIR/$_iu.tmp"
  mv "$QUADLET_DIR/$_iu.tmp" "$QUADLET_DIR/$_iu"
}

# The release's systemd units this instance runs: WAL-G's backup service and timer need the
# bundled Postgres (commonair-backup.service is Requisite= on it).
systemd_unit_in_mode() {
  case "$1" in
    commonair-backup.service | commonair-backup.timer) [ "$STATE_MODE" != external ] ;;
    *) return 0 ;;
  esac
}

# Podman secrets the units read, re-created from the env file every time (idempotent). With
# external Postgres and Valkey, the owner's and Valkey's passwords are not in the env file: their
# secrets are re-created only when this run was given the password (state_secrets).
create_secrets() {
  _app=$(env_get POSTGRES_APP_PASSWORD "$ENV_FILE")
  _owner=$(env_get POSTGRES_PASSWORD "$ENV_FILE")
  _grafana=$(env_get GRAFANA_ADMIN_PASSWORD "$ENV_FILE")
  if [ -z "$_app" ] || [ -z "$_grafana" ] || { [ -z "$_owner" ] && [ "$STATE_MODE" != external ]; }; then
    die "$ENV_FILE lacks POSTGRES_APP_PASSWORD, POSTGRES_PASSWORD or GRAFANA_ADMIN_PASSWORD"
  fi
  if [ "$STATE_MODE" = external ]; then
    state_secrets "$_app" "$_grafana"
    info "podman secrets updated"
    return 0
  fi
  # printf is a shell builtin: the values never appear in a process list.
  printf 'postgres://commonair_app:%s@postgres:5432/commonair' "$_app" |
    podman secret create --replace commonair-database-url - >/dev/null
  printf 'postgres://commonair:%s@postgres:5432/commonair' "$_owner" |
    podman secret create --replace commonair-owner-database-url - >/dev/null
  printf '%s' "$_grafana" | podman secret create --replace commonair-grafana-admin-password - >/dev/null
  _vurl=$(env_get VALKEY_URL "$ENV_FILE")
  [ -n "$_vurl" ] || die "$ENV_FILE lacks VALKEY_URL"
  printf '%s' "$_vurl" | podman secret create --replace commonair-valkey-url - >/dev/null
  # The metrics collector's (contract §3.7): the monitor role's password, and Valkey's own, since
  # the bundled Valkey has only its default user.
  monitor_password_secret
  _vpw=$(env_get VALKEY_PASSWORD "$ENV_FILE")
  printf '%s' "$_vpw" | podman secret create --replace commonair-valkey-monitor-password - >/dev/null
  info "podman secrets updated"
}

monitor_password_secret() {
  _mon=$(env_get POSTGRES_MONITOR_PASSWORD "$ENV_FILE")
  [ -n "$_mon" ] || die "$ENV_FILE lacks POSTGRES_MONITOR_PASSWORD"
  printf '%s' "$_mon" | podman secret create --replace commonair-pg-monitor-password - >/dev/null
}

# Host files the units this instance runs bind-mount outside the release directory (derived from
# Volume= lines): hash lists, the moderation and captions models and the IRC certificate directory.
host_mount_sources() {
  for _u in "$1"/quadlet/*.container "$1/$OPTIONAL_UNIT_DIR"/*.container; do
    [ -f "$_u" ] || continue
    if unit_in_mode "$(basename "$_u")"; then sed -n 's|^Volume=%h/\([^:]*\):.*|\1|p' "$_u"; fi
  done | grep -v '^commonair/' | sort -u
}

prepare_mounts() {
  _rel=$1
  for _src in $(host_mount_sources "$_rel"); do
    _path="$HOME/$_src"
    case "$_src" in
      *.pdq)
        mkdir -p "$(dirname "$_path")"
        if [ ! -e "$_path" ]; then
          : >"$_path"
          warn "EMPTY hash list $_path: known-image matching (CSAM/NCII) is OFF until you install a list there"
        elif [ ! -s "$_path" ]; then
          warn "hash list $_path is still EMPTY: known-image matching is OFF"
        fi
        ;;
      *.onnx) fetch_model "$_rel" "$_path" moderation "$MODEL_SRC" --model ;;
      # Only mounted, so only fetched, with captions on (host_mount_sources).
      *.bin) fetch_model "$_rel" "$_path" captions "$CAPTIONS_MODEL_SRC" --captions-model ;;
      *) mkdir -p "$_path" ;;
    esac
  done
}

# Model weights ($3: moderation or captions), verified against the pinned sha256 by fetch-model
# in the tools image. $4: an operator's local copy (passed as $5), used when none is there yet.
fetch_model() {
  _dir=$(dirname "$2")
  _file=$(basename "$2")
  mkdir -p "$_dir"
  # selfhost.sh up to 0.1.0-rc.2 made every mount source it did not know a directory, so its
  # upgrade to rc.3 left an empty one where the captions weights go (whisper then failed with
  # "invalid model data (bad magic)"). An empty one goes; anything else is the operator's.
  if [ -d "$2" ] && [ ! -L "$2" ]; then
    rmdir "$2" 2>/dev/null || die "$2 is a directory, not the $3 model" "fix: move it away, then re-run"
    info "removed the empty directory $2 (an older selfhost.sh made it where the $3 model goes)"
  fi
  if [ -n "$4" ] && [ ! -e "$2" ]; then
    [ -f "$4" ] || die "no such model file: $4"
    cp "$4" "$2"
  fi
  info "checking the $3 model (downloads it if missing)"
  podman run --rm --user 0:0 --entrypoint bun \
    -v "$1/tools:/tools:ro,Z" -v "$_dir:/models:z" -w /tools \
    "$(tools_image "$1")" /tools/fetch-model.js --model "$3" --out "/models/$_file" >/dev/null ||
    die "the $3 model is missing or does not match its pinned sha256" \
      "fix: re-run with network access, or pass $5 <path> with a verified copy"
}

install_units() {
  _rel=$1
  # Open seed mode's units and close timer are not the release's: this would drop the timer and
  # leave seed mode open with nothing to close it (ADR 0040). Its callers refuse first.
  if seed_mode_open; then
    die "install_units refused: staging seed mode is open" "fix: selfhost.sh seed-mode close first"
  fi
  mkdir -p "$QUADLET_DIR" "$SYSTEMD_DIR"
  # Closed, no seed-mode drop-in may stay (one left behind when its state was removed by hand
  # would keep trusting the harness's address as a proxy). The directory only if that empties it.
  for _f in "$QUADLET_DIR"/commonair-*.container.d/"$SEED_DROPIN"; do
    [ -e "$_f" ] || [ -L "$_f" ] || continue
    info "removing ${_f#"$QUADLET_DIR"/} (staging seed mode is closed)"
    rm -f "$_f"
    rmdir "${_f%/*}" 2>/dev/null || true
  done
  # A container unit this install drops (rc.2's commonair-garage-init, now storage-init) is
  # stopped while its generated service still exists: after the daemon-reload below systemd
  # could no longer stop it by its unit file, and a one-shot would stay "active" forever.
  for _f in "$QUADLET_DIR"/commonair-*.container; do
    [ -f "$_f" ] || continue
    _n=$(basename "$_f")
    if [ -z "$(release_unit_path "$_rel" "$_n")" ] || ! unit_in_mode "$_n"; then
      info "stopping ${_n%.container} (not part of this install)"
      systemctl --user stop "${_n%.container}.service" >/dev/null 2>&1 || true
    fi
  done
  # Operator drop-ins (commonair-<unit>.container.d/, e.g. for a GPU) are directories and stay,
  # also when the directory is a symlink (-d follows it); a symlink to a unit file goes, and so
  # does a dangling drop-in symlink (its target is gone, so there is nothing to keep).
  for _f in "$QUADLET_DIR"/commonair*; do
    [ -d "$_f" ] && continue
    if [ -f "$_f" ] || [ -L "$_f" ]; then rm -f "$_f"; fi
  done
  # With an external object store, Garage and its volumes are not installed at all; with external
  # Postgres and Valkey, neither are theirs, and the rest are rendered without edges to them.
  for _f in "$_rel"/quadlet/* "$_rel/$OPTIONAL_UNIT_DIR"/*; do
    [ -f "$_f" ] || continue
    unit_in_mode "$(basename "$_f")" || continue
    if [ "${STATE_MODE:-bundled}" = external ]; then install_unit_file "$_rel" "$_f"; else cp "$_f" "$QUADLET_DIR/"; fi
  done
  # Units in ~/.config/systemd/user shadow Quadlet's generated ones, so a commonair-* unit the
  # release does not ship (an older release's, or one copied by hand for a manual install) goes.
  for _f in "$SYSTEMD_DIR"/commonair-*; do
    [ -e "$_f" ] || [ -L "$_f" ] || continue
    # A commonair-*.service.d drop-in (or a symlink to one) stays; a dangling symlink is removed
    # below unless the release ships that name.
    [ -d "$_f" ] && continue
    _n=$(basename "$_f")
    if [ -e "$_rel/systemd/$_n" ] && { [ "${STATE_MODE:-bundled}" != external ] || systemd_unit_in_mode "$_n"; }; then
      continue
    fi
    case "$_n" in *.timer | *.socket) systemctl --user disable --now "$_n" >/dev/null 2>&1 || true ;; esac
    info "removing $_n (not part of this release)"
    rm -f "$_f"
  done
  if [ "${STATE_MODE:-bundled}" != external ]; then
    cp "$_rel"/systemd/* "$SYSTEMD_DIR/"
  else
    for _f in "$_rel"/systemd/*; do
      if systemd_unit_in_mode "$(basename "$_f")"; then cp "$_f" "$SYSTEMD_DIR/"; fi
    done
  fi
  # Each unit's env file is rendered from commonair.env at every start of the unit (ExecStartPre=
  # with the release's render-env.sh and key list). Drop the old ones, so no copy of a secret
  # stays behind for a unit this release no longer has, or under a key it no longer passes.
  rm -rf "$UNIT_ENV_DIR"
  systemctl --user daemon-reload
  stop_orphan_units
  info "units installed from $_rel"
}

# A service whose unit file is gone keeps running as "not-found" until something stops it: the
# rollback of an rc.2 script's upgrade to rc.3 removed seed mode's units (and coturn's) without
# stopping them. Nothing else would, and a later start of the same name finds it already active
# and keeps the old container.
stop_orphan_units() {
  for _s in $(systemctl --user list-units --all --plain --no-legend --type=service 'commonair-*' 2>/dev/null |
    awk '{ if ($1 == "●") { $1 = ""; $0 = $0 } } $2 == "not-found" && $3 != "inactive" { print $1 }'); do
    info "stopping $_s (its unit file is gone)"
    systemctl --user stop "$_s" >/dev/null 2>&1 || true
  done
}

# Long-running services, from the installed units (one-shots run as their dependencies).
services() {
  for _u in "$QUADLET_DIR"/commonair-*.container; do
    grep -q '^Type=oneshot' "$_u" && continue
    _n=$(basename "$_u" .container)
    printf '%s.service\n' "$_n"
  done
}

all_units() {
  for _u in "$QUADLET_DIR"/commonair-*.container; do
    printf '%s.service\n' "$(basename "$_u" .container)"
  done
}

# Socket units (Caddy's and IRC's public ports, held by systemd and passed to the service).
sockets() {
  for _u in "$SYSTEMD_DIR"/commonair-*.socket; do
    [ -f "$_u" ] && basename "$_u"
  done
  return 0
}

# True when the commonair network's lease range leaves out the fixed addresses the services trust
# (Caddy 10.89.42.10, web .11): a network this release created, or one an operator already fixed.
network_lease_ok() {
  _lease=$(podman network inspect commonair \
    --format '{{range .Subnets}}{{if .LeaseRange}}{{.LeaseRange.StartIP}}{{end}}{{end}}' 2>/dev/null) || _lease=""
  case "$_lease" in
    10.89.42.*) [ "${_lease##*.}" -gt 11 ] 2>/dev/null ;;
    *) return 1 ;;
  esac
}

# Quadlet never changes an existing network, so a network from before IPRange is removed for
# commonair-network.service to create again. One that is already right is kept: removing it would
# gain nothing, and a rollback must not depend on it.
recreate_network() {
  podman network exists commonair 2>/dev/null || return 0
  network_lease_ok && return 0
  systemctl --user stop commonair-network.service 2>/dev/null || true
  podman network rm commonair >/dev/null 2>&1 && return 0
  warn "could not remove the commonair network, and it can lease the fixed addresses 10.89.42.10/.11 the services trust" \
    "(lease range start: ${_lease:-none}). Stop whatever else uses it (podman network inspect commonair), then re-run."
  return 1
}

# The container names the installed units run (ContainerName=), one per line.
instance_containers() {
  for _u in "$QUADLET_DIR"/commonair-*.container; do
    [ -f "$_u" ] && sed -n 's/^ContainerName=//p' "$_u"
  done
  return 0
}

# Before anything is stopped (an upgrade, a re-install, a rollback): a network that must be
# re-created but that a container outside the instance holds cannot be removed, and the restart
# would end with everything down. Outside means not named by an installed unit, whatever its name.
network_preflight() {
  podman network exists commonair 2>/dev/null || return 0
  network_lease_ok && return 0
  _ours=$(instance_containers)
  _foreign=$(podman ps -a --filter network=commonair --format '{{.Names}}' 2>/dev/null |
    while IFS= read -r _n; do
      [ -n "$_n" ] && ! printf '%s\n' "$_ours" | grep -qxF "$_n" && printf '%s\n' "$_n"
    done || true)
  [ -z "$_foreign" ] || die "the commonair network must be re-created, but containers outside the instance use it: $(printf '%s' "$_foreign" | tr '\n' ' ')" \
    "fix: remove them from the network (podman network disconnect commonair <name>), then re-run; nothing was changed"
}

# Runs migrate to completion within HEALTH_TIMEOUT. Postgres never gives up (Restart=always,
# RestartMode=direct, no start limit), so with an image that never gets healthy its start job,
# and migrate's queued behind it (After=), never end: an unbounded start would hang here and
# never reach the rollback. Stopping both cancels those jobs, which also ends the client.
# Backgrounded and polled, not timeout(1), which the test hosts (macOS) do not have.
start_migrate() {
  systemctl --user start commonair-migrate.service &
  _mpid=$!
  _deadline=$(($(date +%s) + HEALTH_TIMEOUT))
  while kill -0 "$_mpid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$_deadline" ]; then
      warn "migrations did not finish within ${HEALTH_TIMEOUT}s (is Postgres healthy?)"
      systemctl --user stop commonair-migrate.service commonair-postgres.service 2>/dev/null || true
      kill "$_mpid" 2>/dev/null || true
      wait "$_mpid" 2>/dev/null || true
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done
  wait "$_mpid"
}

# ADR 0023 §9: everything down, migrations to completion, then the rest.
restart_stack() {
  network_preflight
  # The sockets first: a connection to one would start Caddy (and what it wants) mid-upgrade.
  # shellcheck disable=SC2046 # unit names have no spaces
  systemctl --user stop $(sockets) $(all_units) 2>/dev/null || true
  recreate_network || return 1
  # migrate and garage-init retry with a start limit; a release whose migrate kept failing
  # leaves them start-limit-hit, which would refuse this start (a rollback, or a re-run) for
  # up to an hour.
  systemctl --user reset-failed 'commonair-*' 2>/dev/null || true
  info "running migrations (commonair-migrate)"
  start_migrate || return 1
  info "starting the stack"
  # shellcheck disable=SC2046
  systemctl --user start --no-block $(sockets) $(services)
  # Enabled, a socket also listens at boot, before Caddy is up (connections wait in its queue).
  # WAL-G's daily base backup runs only against the bundled Postgres.
  _timers="commonair-irc-cert.timer"
  if [ "${STATE_MODE:-bundled}" != external ]; then _timers="commonair-backup.timer $_timers"; fi
  # shellcheck disable=SC2046,SC2086
  systemctl --user enable --now $(sockets) $_timers >/dev/null 2>&1 || true
}

unit_healthy() {
  [ "$(systemctl --user is-active "$1" 2>/dev/null || true)" = active ] || return 1
  _c=$(sed -n 's/^ContainerName=//p' "$QUADLET_DIR/${1%.service}.container")
  _h=$(podman inspect --format '{{.State.Health.Status}}' "$_c" 2>/dev/null || true)
  [ -z "$_h" ] || [ "$_h" = healthy ]
}

# A unit that is neither running nor restarting gets started again. That is a unit whose start
# job failed with result 'dependency' (a one-shot it Requires= failed, now retried or reset),
# which Restart= never retries; units only Want= long-running services, so this is rare.
kick_if_stopped() {
  case "$(systemctl --user is-active "$1" 2>/dev/null || true)" in
    failed | inactive)
      systemctl --user reset-failed "$1" 2>/dev/null || true
      systemctl --user start --no-block "$1" 2>/dev/null || true
      ;;
  esac
}

# Waits until every long-running unit is active and healthy (IRC only with $1 = all).
wait_healthy() {
  _deadline=$(($(date +%s) + HEALTH_TIMEOUT))
  while :; do
    _pending=""
    for _s in $(services); do
      if [ "$1" != all ] && [ "$_s" = commonair-irc.service ]; then continue; fi
      unit_healthy "$_s" && continue
      _pending="$_pending ${_s%.service}"
      kick_if_stopped "$_s"
    done
    if [ -z "$_pending" ]; then return 0; fi
    if [ "$(date +%s)" -ge "$_deadline" ]; then
      warn "not healthy after ${HEALTH_TIMEOUT}s:$_pending"
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done
}

# IRC refuses to start without a certificate; Caddy gets one shortly after it starts.
first_irc_cert() {
  _deadline=$(($(date +%s) + IRC_CERT_TIMEOUT))
  until systemctl --user start commonair-irc-cert.service >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$_deadline" ]; then
      warn "Caddy has no certificate for $(env_get IRC_PUBLIC_HOST "$ENV_FILE") yet (does DNS point here?); continuing without IRC."
      warn "commonair-irc-cert.timer retries daily; once DNS resolves, run it now: systemctl --user start commonair-irc-cert.service"
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done
  info "IRC certificate in place"
}

bring_up() {
  restart_stack || return 1
  wait_healthy core || return 1
  # Without DNS yet (ACME), there is no certificate: everything else is up, IRC TLS follows
  # once the daily timer finds one (or the operator starts commonair-irc-cert.service).
  if first_irc_cert; then wait_healthy all; fi
}

switch_current() {
  if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
    die "$CURRENT_LINK exists and is not a symlink (a git clone?)" \
      "fix: move it away; selfhost.sh manages $CURRENT_LINK as a link to the current release"
  fi
  ln -sfn "$1" "$CURRENT_LINK"
}

save_conf() {
  (umask 077 && printf 'REGISTRY=%s\n' "$1" >"$SELFHOST_CONF")
}

next_steps() {
  _host=$(env_get PUBLIC_HOSTNAME "$ENV_FILE")
  say ""
  say "CommonAir $(installed_version) is running: https://$_host/"
  say ""
  say "Next steps:"
  say "  - Point DNS for $_host at this server (A/AAAA) if you have not yet."
  say "  - Set real SMTP_* values in $ENV_FILE and review the instance contacts"
  say "    (CONTACT_EMAIL, SECURITY_EMAIL, ...) there. Apply edits to that file with:"
  say "      sh $CURRENT_LINK/selfhost.sh install --reinstall"
  say "    (keeps secrets and the installed release)."
  if [ "$(env_get TLS_MODE "$ENV_FILE")" = internal ]; then
    say "  - TLS uses Caddy's internal CA. Trust its root on your clients:"
    say "      $(caddy_root_path)"
  fi
  if [ "$STATE_MODE" = external ]; then
    say "  - Backups: the database is your provider's to back up (point-in-time recovery);"
    say "    see docs/self-hosting/managed-services.md."
  else
    say "  - Backups: commonair-backup.timer runs daily; selfhost.sh backup runs one now."
  fi
  say "  - selfhost.sh status shows units, health, TLS and backups."
}

# The site certificate's notAfter, when openssl is installed (cheap: a file read).
cert_expiry() {
  have openssl || return 0
  _host=$(env_get PUBLIC_HOSTNAME "$ENV_FILE")
  _mp=$(podman volume inspect commonair-caddy-data --format '{{.Mountpoint}}' 2>/dev/null || true)
  [ -n "$_host" ] && [ -n "$_mp" ] || return 0
  for _crt in "$_mp"/caddy/certificates/*/"$_host"/"$_host".crt; do
    [ -f "$_crt" ] && openssl x509 -enddate -noout -in "$_crt" 2>/dev/null | sed 's/^notAfter=//' && return 0
  done
  return 0
}

caddy_root_path() {
  _mp=$(podman volume inspect commonair-caddy-data --format '{{.Mountpoint}}' 2>/dev/null || true)
  printf '%s/caddy/pki/authorities/local/root.crt' "${_mp:-<commonair-caddy-data volume>}"
}

# --- commands -----------------------------------------------------------------------------

parse_flags() {
  VERSION=""
  BUNDLE=""
  SUMS_FILE=""
  DOMAIN=""
  EMAIL=""
  TLS=""
  REGISTRY=""
  PUBLIC_IP=""
  MODEL_SRC=""
  REQUIRE_SIGNATURE=no
  INSECURE_NO_CHECKSUM=no
  UNSUPPORTED_DISTRO=no
  YES=no
  REINSTALL=no
  S3_FLAGS=no
  S3_OPT_ENDPOINT=""
  S3_OPT_REGION=""
  S3_OPT_PATH_STYLE=""
  S3_OPT_PUBLIC=""
  S3_OPT_BUCKET_MEDIA=""
  S3_OPT_BUCKET_EXPORTS=""
  S3_OPT_BUCKET_BACKUPS=""
  S3_OPT_BUCKET_EVIDENCE=""
  S3_ALLOW_HTTP=no
  # External Postgres and Valkey (empty: bundled, or what commonair.env says).
  DB_OPT_URL=""
  DB_OPT_CA=""
  VK_OPT_URL=""
  VK_OPT_CA=""
  DB_ALLOW_INSECURE=no
  VK_ALLOW_INSECURE=no
  # The TURN relay: on, off, or empty (keep what commonair.env says; off on a first install).
  TURN_RELAY=""
  # Browser push: on, off, or empty (keep what commonair.env says; off on a first install).
  WEB_PUSH=""
  # Live captions: on, off, or empty (keep what commonair.env says; off on a first install).
  CAPTIONS=""
  CAPTIONS_MODEL_SRC=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --version | --bundle | --sha256sums | --domain | --email | --tls | --registry | --public-ip | --model | --captions-model)
        [ $# -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --version)
            VERSION=${2#v}
            is_version "$VERSION" || die "not a release version: $2 (want vX.Y.Z or vX.Y.Z-pre)"
            ;;
          --bundle) BUNDLE=$2 ;;
          --sha256sums) SUMS_FILE=$2 ;;
          --domain) DOMAIN=$2 ;;
          --email) EMAIL=$2 ;;
          --tls) TLS=$2 ;;
          --registry) REGISTRY=$2 ;;
          --public-ip) PUBLIC_IP=$2 ;;
          --model) MODEL_SRC=$2 ;;
          --captions-model) CAPTIONS_MODEL_SRC=$2 ;;
        esac
        shift 2
        ;;
      --s3-endpoint | --s3-region | --s3-path-style | --s3-public-endpoint | --s3-bucket-media | \
        --s3-bucket-exports | --s3-bucket-backups | --s3-bucket-evidence)
        [ $# -ge 2 ] || die "$1 needs a value"
        S3_FLAGS=yes
        case "$1" in
          --s3-endpoint) S3_OPT_ENDPOINT=${2%/} ;;
          --s3-region) S3_OPT_REGION=$2 ;;
          --s3-path-style) S3_OPT_PATH_STYLE=$2 ;;
          --s3-public-endpoint) S3_OPT_PUBLIC=${2%/} ;;
          --s3-bucket-media) S3_OPT_BUCKET_MEDIA=$2 ;;
          --s3-bucket-exports) S3_OPT_BUCKET_EXPORTS=$2 ;;
          --s3-bucket-backups) S3_OPT_BUCKET_BACKUPS=$2 ;;
          --s3-bucket-evidence) S3_OPT_BUCKET_EVIDENCE=$2 ;;
        esac
        shift 2
        ;;
      --s3-allow-http) S3_ALLOW_HTTP=yes && shift ;;
      --database-url | --database-ca | --valkey-url | --valkey-ca)
        [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
        case "$1" in
          --database-url) DB_OPT_URL=$2 ;;
          --database-ca) DB_OPT_CA=$2 ;;
          --valkey-url) VK_OPT_URL=$2 ;;
          --valkey-ca) VK_OPT_CA=$2 ;;
        esac
        shift 2
        ;;
      --allow-insecure-database) DB_ALLOW_INSECURE=yes && shift ;;
      --allow-insecure-valkey) VK_ALLOW_INSECURE=yes && shift ;;
      --database-pass* | --valkey-pass* | --db-pass* | --pg-pass*)
        die "passwords are never flags: every user on this host can read a command line (ps)" \
          "fix: export DATABASE_PASSWORD and VALKEY_PASSWORD in the shell that runs selfhost.sh, or run it" \
          "from a terminal, which asks for them (without echo)"
        ;;
      # coturn's TURN relay (docs/self-hosting/p2p.md). Kept in commonair.env, so it persists
      # across upgrades and reinstalls until the opposite flag.
      --turn-relay) TURN_RELAY=on && shift ;;
      --no-turn-relay) TURN_RELAY=off && shift ;;
      # Browser push (ADR 0028). Kept in commonair.env, like the TURN relay.
      --web-push) WEB_PUSH=on && shift ;;
      --no-web-push) WEB_PUSH=off && shift ;;
      # The whisper captions sidecar (docs/self-hosting/captions.md). Kept in commonair.env.
      --captions) CAPTIONS=on && shift ;;
      --no-captions) CAPTIONS=off && shift ;;
      --s3-*key* | --s3-*secret*)
        die "S3 keys are never flags: every user on this host can read a command line (ps)" \
          "fix: export S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_EVIDENCE_ACCESS_KEY_ID and S3_EVIDENCE_SECRET_ACCESS_KEY" \
          "in the shell that runs install, or run it from a terminal, which prompts for them"
        ;;
      --require-signature) REQUIRE_SIGNATURE=yes && shift ;;
      --insecure-no-checksum) INSECURE_NO_CHECKSUM=yes && shift ;;
      --unsupported-distro) UNSUPPORTED_DISTRO=yes && shift ;;
      --yes | -y) YES=yes && shift ;;
      --reinstall) REINSTALL=yes && shift ;;
      -h | --help) usage && exit 0 ;;
      *) die "unknown option: $1" "see: selfhost.sh --help" ;;
    esac
  done
  if [ -n "$VERSION" ] && [ -n "$BUNDLE" ]; then die "--version and --bundle are exclusive"; fi
  if [ "$INSECURE_NO_CHECKSUM" = yes ] && [ -z "$BUNDLE" ]; then die "--insecure-no-checksum only applies to a local --bundle"; fi
  if [ -n "$DOMAIN" ] && ! is_hostname "$DOMAIN"; then die "not a hostname: $DOMAIN"; fi
  if [ -n "$EMAIL" ] && ! is_email "$EMAIL"; then die "not an email address: $EMAIL"; fi
  case "$TLS" in "" | acme | internal) ;; *) die "--tls must be acme or internal, not $TLS" ;; esac
  if [ -n "$REGISTRY" ] && ! is_registry "$REGISTRY"; then die "not a registry: $REGISTRY"; fi
  if [ -n "$PUBLIC_IP" ] && ! is_addresses "$PUBLIC_IP"; then die "not a comma-separated address list: $PUBLIC_IP"; fi
  for _u in "$S3_OPT_ENDPOINT" "$S3_OPT_PUBLIC"; do
    [ -n "$_u" ] || continue
    is_s3_url "$_u" || die "not an S3 endpoint: $_u (want https://host or https://host:port, no path)"
    case "$_u" in
      http://*)
        [ "$S3_ALLOW_HTTP" = yes ] || die "$_u is plain http: objects and presigned URLs would cross the network unencrypted" \
          "fix: use the store's https:// endpoint, or pass --s3-allow-http for a store on a trusted network (a LAN, a test host)"
        ;;
    esac
  done
  if [ -n "$S3_OPT_REGION" ] && ! is_s3_region "$S3_OPT_REGION"; then die "not an S3 region: $S3_OPT_REGION"; fi
  case "$S3_OPT_PATH_STYLE" in "" | true | false) ;; *) die "--s3-path-style must be true or false, not $S3_OPT_PATH_STYLE" ;; esac
  for _b in "$S3_OPT_BUCKET_MEDIA" "$S3_OPT_BUCKET_EXPORTS" "$S3_OPT_BUCKET_BACKUPS" "$S3_OPT_BUCKET_EVIDENCE"; do
    if [ -n "$_b" ] && ! is_bucket "$_b"; then
      die "not a bucket name: $_b (3-63 lowercase letters, digits, dots and hyphens; no '..')"
    fi
  done
  for _f in "$BUNDLE" "$SUMS_FILE" "$MODEL_SRC" "$CAPTIONS_MODEL_SRC" "$DB_OPT_CA" "$VK_OPT_CA"; do
    case "$_f" in *[[:space:]]*) die "paths with spaces are not supported: $_f" ;; esac
  done
  check_state_flags
  if [ -n "$CAPTIONS_MODEL_SRC" ] && [ "$CAPTIONS" = off ]; then die "--captions-model and --no-captions contradict each other"; fi
  return 0
}

cmd_install() {
  parse_flags "$@"
  if [ "$(id -u)" = 0 ]; then
    if [ "$YES" != yes ]; then
      die "running as root: this prepares the host (podman, user $SERVICE_USER, linger, sysctl)" \
        "re-run with --yes to allow that, or run as the user that will own the instance"
    fi
    precheck_storage_as_root
    precheck_state_as_root
    root_prepare
    run_as_service_user
  fi
  resolve_repository_url
  if instance_exists && [ "$REINSTALL" != yes ]; then
    die "an instance is already installed (version $(installed_version))" \
      "re-run with --reinstall to reinstall it (secrets are kept), or use: selfhost.sh upgrade"
  fi
  if instance_exists; then refuse_while_seed_mode "install --reinstall"; fi
  if [ -z "$DOMAIN" ]; then DOMAIN=$(env_get PUBLIC_HOSTNAME "$ENV_FILE"); fi
  [ -n "$DOMAIN" ] || die "--domain is required on the first install"
  if [ -z "$EMAIL" ] && [ -z "$(env_get CONTACT_EMAIL "$ENV_FILE")" ]; then
    die "--email is required on the first install (ACME notices and the instance contacts)"
  fi
  if [ -z "$TLS" ]; then TLS=$(env_get TLS_MODE "$ENV_FILE"); fi
  TLS=${TLS:-acme}
  if [ -z "$REGISTRY" ] && [ -f "$SELFHOST_CONF" ]; then REGISTRY=$(env_get REGISTRY "$SELFHOST_CONF"); fi
  resolve_storage
  resolve_state_settings

  host_checks
  collect_state_secrets
  if [ -z "$VERSION" ] && [ -z "$BUNDLE" ] && [ -L "$CURRENT_LINK" ]; then
    # --reinstall alone: re-apply flags and commonair.env edits to the installed release.
    RELEASE_DIR=$(readlink "$CURRENT_LINK")
    BUNDLE_VERSION=$(installed_version)
    [ -d "$RELEASE_DIR" ] || die "the installed release $RELEASE_DIR is missing" "fix: install --reinstall --version vX.Y.Z"
    info "reusing the installed release $BUNDLE_VERSION"
  else
    obtain_bundle
    extract_bundle
  fi
  check_captions "$RELEASE_DIR"
  apply_registry "$RELEASE_DIR" "$REGISTRY"
  pull_images "$RELEASE_DIR"
  state_preflight "$RELEASE_DIR"
  write_env "$RELEASE_DIR"
  configure_env
  create_secrets
  _old=$(readlink "$CURRENT_LINK" 2>/dev/null || true)
  if [ -n "$_old" ] && [ "$_old" != "$RELEASE_DIR" ]; then ln -sfn "$_old" "$PREVIOUS_LINK"; fi
  switch_current "$RELEASE_DIR"
  save_conf "$REGISTRY"
  prepare_mounts "$RELEASE_DIR"
  install_units "$RELEASE_DIR"
  bring_up || die "the instance did not become healthy" \
    "see: selfhost.sh status, and journalctl --user -u 'commonair-*'"
  next_steps
}

# External state takes no pre-upgrade backup: the provider's point-in-time recovery is the net.
rollback_last_resort() {
  if [ "$STATE_MODE" = external ]; then
    printf '%s' "last resort if the schema change broke it: restore the database to a point just before the upgrade with your provider's point-in-time recovery ($STATE_DOC)"
  else
    printf '%s' "last resort if the schema change broke it: restore the pre-upgrade backup (selfhost.sh backup lists it)"
  fi
}

rollback() {
  _prev=$1
  warn "rolling back to $(env_get COMMONAIR_VERSION "$_prev/release.env")"
  ln -sfn "$_prev" "$CURRENT_LINK"
  install_units "$_prev"
  if bring_up; then
    die "upgrade failed; rolled back to $(installed_version), which is healthy" \
      "the failed release stays in $RELEASES_DIR for inspection" \
      "$(rollback_last_resort)"
  fi
  die "upgrade failed and the rollback is not healthy either" "see: selfhost.sh status"
}

prune_releases() {
  _keep_cur=$(readlink "$CURRENT_LINK")
  _keep_prev=$(readlink "$PREVIOUS_LINK" 2>/dev/null || true)
  for _d in "$RELEASES_DIR"/*; do
    [ -d "$_d" ] || continue
    if [ "$_d" != "$_keep_cur" ] && [ "$_d" != "$_keep_prev" ]; then
      info "removing old release $(basename "$_d")"
      rm -rf "$_d"
    fi
  done
}

# The instance lives in the service user's home and runs under its systemd user manager. Root
# and a user reached by su/sudo (no user manager) get the fix, not an empty status.
require_instance() {
  if [ "$(id -u)" = 0 ]; then
    die "$1 runs as the user that owns the instance, not as root" \
      "fix: log in as $SERVICE_USER over SSH (install.md, step 5) and run: sh ~/commonair/selfhost.sh $1"
  fi
  [ -L "$CURRENT_LINK" ] || die "no instance installed here" "fix: selfhost.sh install"
  check_systemd
}

cmd_upgrade() {
  parse_flags "$@"
  require_instance upgrade
  refuse_while_seed_mode upgrade
  _cur=$(readlink "$CURRENT_LINK")
  _curv=$(installed_version)
  [ "$S3_FLAGS" = no ] || die "the object store is chosen at install: --s3-* flags apply to install --reinstall, not upgrade"
  if [ -n "$DB_OPT_URL$VK_OPT_URL" ]; then
    die "Postgres and Valkey are chosen at install: --database-url and --valkey-url apply to install --reinstall, not upgrade" \
      "an upgrade keeps them as installed (--database-ca and --valkey-ca may replace a CA)"
  fi
  read_storage_mode "$ENV_FILE"
  resolve_state_settings
  resolve_repository_url
  if [ -z "$REGISTRY" ] && [ -f "$SELFHOST_CONF" ]; then REGISTRY=$(env_get REGISTRY "$SELFHOST_CONF"); fi
  check_podman
  collect_state_secrets

  # 1. download and verify
  obtain_bundle
  [ "$BUNDLE_VERSION" != "$_curv" ] || die "version $_curv is already installed"
  extract_bundle
  check_captions "$RELEASE_DIR"
  apply_registry "$RELEASE_DIR" "$REGISTRY"
  # 2. pull every image by digest (nothing has changed yet if this fails)
  pull_images "$RELEASE_DIR"
  state_preflight "$RELEASE_DIR"
  network_preflight
  # 3. base backup of the current database (WAL-G, bundled Postgres only: an external one has its
  # provider's point-in-time recovery, docs/self-hosting/managed-services.md)
  if [ "$STATE_MODE" != external ]; then
    info "taking a base backup before the upgrade"
    systemctl --user start commonair-backup.service ||
      die "the pre-upgrade backup failed; nothing was changed" "see: journalctl --user -u commonair-backup"
  else
    info "external Postgres: no WAL-G backup here; the provider's point-in-time recovery covers the upgrade"
  fi
  # The new release's tools (init-env) may add variables; existing values are kept.
  write_env "$RELEASE_DIR"
  backfill_env
  create_secrets
  prepare_mounts "$RELEASE_DIR"
  # 4. install the new units
  ln -sfn "$_cur" "$PREVIOUS_LINK"
  ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
  save_conf "$REGISTRY"
  install_units "$RELEASE_DIR"
  # 5 and 6. migrate to completion, then restart the stack and wait for health
  info "upgrading $_curv -> $BUNDLE_VERSION"
  if ! bring_up; then rollback "$_cur"; fi
  prune_releases
  info "upgraded to $(installed_version)"
}

# --- backups ------------------------------------------------------------------------------
#
# `backup` takes a WAL-G base backup (--database, the default) and copies the media and evidence
# buckets to an offsite S3 store (--objects); `backup --restore-objects` copies them back. Exports
# are not copied: each expires after 7 days and a member can request a new one. The backups bucket
# is not either: WAL-G sends it off the host itself (WALG_S3_PREFIX, backups.md).
#
# rclone runs on the host, from the distribution's package: a container would need its own pinned
# image, and rclone would then reach Garage over the commonair network instead of the loopback
# port Garage already publishes for this. Its configuration reaches it only through
# RCLONE_CONFIG_<REMOTE>_* variables, in a subshell, never on its command line or in a file.
#
# With an external store (S3_MODE=external) the objects already live off the host; --objects
# copies them bucket to bucket all the same, so losing the provider account or region does not
# lose them. Versioning at the provider is the operator's choice on top of that.

OBJECT_STATE_DIR="$HOME/.local/state/commonair"
OBJECT_STATE="$OBJECT_STATE_DIR/object-backup"
OBJECT_TIMER="commonair-object-backup.timer"
# Garage's S3 port, published on the loopback only (commonair-garage.container).
GARAGE_HOST_ENDPOINT="http://127.0.0.1:3900"
OBJECT_BACKUP_KEY_NAME="commonair-object-backup"
# A symlink whose target is the holder's pid: ln -s creates it atomically, pid and all.
OBJECT_LOCK="$OBJECT_STATE_DIR/object-backup.lock"
# Present from the start of a --restore-objects until it succeeds: the instance may lack objects
# the copy still has, and a sync then would delete them from the copy.
OBJECT_RESTORE_MARK="$OBJECT_STATE_DIR/object-restore-incomplete"
OBJECT_MAX_DELETE_DEFAULT=1000

parse_backup_flags() {
  BACKUP_DATABASE=no
  BACKUP_OBJECTS=no
  RESTORE_OBJECTS=no
  OBJ_BWLIMIT=""
  OBJ_MAX_DELETE=""
  ALLOW_EMPTY_SOURCE=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --database) BACKUP_DATABASE=yes && shift ;;
      --objects) BACKUP_OBJECTS=yes && shift ;;
      --restore-objects) RESTORE_OBJECTS=yes && shift ;;
      --bwlimit)
        [ $# -ge 2 ] || die "--bwlimit needs a value"
        OBJ_BWLIMIT=$2
        [ -n "$OBJ_BWLIMIT" ] || die "--bwlimit needs a value"
        shift 2
        ;;
      --max-delete)
        [ $# -ge 2 ] || die "--max-delete needs a value"
        OBJ_MAX_DELETE=$2
        [ -n "$OBJ_MAX_DELETE" ] || die "--max-delete needs a value"
        shift 2
        ;;
      --allow-empty-source) ALLOW_EMPTY_SOURCE=yes && shift ;;
      -h | --help) usage && exit 0 ;;
      *) die "unknown backup option: $1" "see: selfhost.sh --help" ;;
    esac
  done
  if [ "$RESTORE_OBJECTS" = yes ] && { [ "$BACKUP_DATABASE" = yes ] || [ "$BACKUP_OBJECTS" = yes ]; }; then
    die "--restore-objects runs on its own, not with --database or --objects"
  fi
  if [ "$BACKUP_OBJECTS" = no ]; then
    [ -z "$OBJ_MAX_DELETE" ] || die "--max-delete applies to --objects only"
    [ "$ALLOW_EMPTY_SOURCE" = no ] || die "--allow-empty-source applies to --objects only"
  fi
  if [ "$BACKUP_OBJECTS" = no ] && [ "$RESTORE_OBJECTS" = no ]; then
    [ -z "$OBJ_BWLIMIT" ] || die "--bwlimit applies to --objects and --restore-objects only"
    BACKUP_DATABASE=yes
  fi
  return 0
}

# rclone's --bwlimit syntax: a rate (20M), up:down rates, or a timetable ("08:00,4M 23:00,off").
is_bwlimit() { printf '%s' "$1" | grep -Eq '^[0-9A-Za-z.:,| -]{1,200}$'; }
# A path below the offsite bucket: segments of letters, digits and . _ -, never "..".
is_prefix() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' && ! printf '%s' "$1" | grep -Eq '(^|/)\.\.?(/|$)'
}

# Reads the offsite store from the env file into OBJ_DST_*: refuses one that is missing or
# incomplete, and never prints a key.
object_remote() {
  _om=""
  for _k in ENDPOINT REGION BUCKET ACCESS_KEY_ID SECRET_ACCESS_KEY; do
    [ -n "$(env_get "BACKUP_OBJECTS_REMOTE_$_k" "$ENV_FILE")" ] || _om="$_om BACKUP_OBJECTS_REMOTE_$_k"
  done
  [ -z "$_om" ] || die "no offsite store for objects: $ENV_FILE lacks$_om" \
    "fix: create a bucket and a key limited to it at a store in another region, add the" \
    "BACKUP_OBJECTS_REMOTE_* settings to $ENV_FILE (docs/self-hosting/backups.md, 'Objects')," \
    "then re-run. Keys go in that file (mode 0600), never on the command line."
  OBJ_DST_ENDPOINT=$(env_get BACKUP_OBJECTS_REMOTE_ENDPOINT "$ENV_FILE")
  OBJ_DST_ENDPOINT=${OBJ_DST_ENDPOINT%/}
  OBJ_DST_REGION=$(env_get BACKUP_OBJECTS_REMOTE_REGION "$ENV_FILE")
  OBJ_DST_BUCKET=$(env_get BACKUP_OBJECTS_REMOTE_BUCKET "$ENV_FILE")
  OBJ_DST_PREFIX=$(env_get BACKUP_OBJECTS_REMOTE_PREFIX "$ENV_FILE" | sed 's|^/*||; s|/*$||')
  OBJ_DST_PATH_STYLE=$(env_get BACKUP_OBJECTS_REMOTE_PATH_STYLE "$ENV_FILE")
  OBJ_DST_PATH_STYLE=${OBJ_DST_PATH_STYLE:-true}
  OBJ_DST_KEY=$(env_get BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID "$ENV_FILE")
  OBJ_DST_SECRET=$(env_get BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY "$ENV_FILE")
  is_s3_url "$OBJ_DST_ENDPOINT" ||
    die "BACKUP_OBJECTS_REMOTE_ENDPOINT is not an S3 endpoint: $OBJ_DST_ENDPOINT (want https://host or https://host:port, no path)"
  case "$OBJ_DST_ENDPOINT" in
    http://*)
      [ "$(env_get BACKUP_OBJECTS_REMOTE_ALLOW_HTTP "$ENV_FILE")" = true ] ||
        die "BACKUP_OBJECTS_REMOTE_ENDPOINT is plain http: the objects would cross the network unencrypted" \
          "fix: use the store's https:// endpoint, or set BACKUP_OBJECTS_REMOTE_ALLOW_HTTP=true for a store on a trusted network"
      ;;
  esac
  is_s3_region "$OBJ_DST_REGION" || die "BACKUP_OBJECTS_REMOTE_REGION is not an S3 region: $OBJ_DST_REGION"
  is_bucket "$OBJ_DST_BUCKET" || die "BACKUP_OBJECTS_REMOTE_BUCKET is not a bucket name: $OBJ_DST_BUCKET"
  if [ -n "$OBJ_DST_PREFIX" ] && ! is_prefix "$OBJ_DST_PREFIX"; then
    die "BACKUP_OBJECTS_REMOTE_PREFIX is not a path: $OBJ_DST_PREFIX (letters, digits, . _ - and /, no '..')"
  fi
  case "$OBJ_DST_PATH_STYLE" in true | false) ;; *) die "BACKUP_OBJECTS_REMOTE_PATH_STYLE must be true or false" ;; esac
  # Never the value in the message: it may be a secret pasted into the wrong line.
  is_s3_key "$OBJ_DST_KEY" || die "BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID is not an S3 key"
  is_s3_key "$OBJ_DST_SECRET" || die "BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY is not an S3 key"
  if [ -z "$OBJ_BWLIMIT" ]; then OBJ_BWLIMIT=$(env_get BACKUP_OBJECTS_BWLIMIT "$ENV_FILE"); fi
  if [ -n "$OBJ_BWLIMIT" ] && ! is_bwlimit "$OBJ_BWLIMIT"; then
    die "not an rclone bandwidth limit: $OBJ_BWLIMIT (e.g. 20M, or \"08:00,4M 23:00,off\")"
  fi
  if [ -z "$OBJ_MAX_DELETE" ]; then OBJ_MAX_DELETE=$(env_get BACKUP_OBJECTS_MAX_DELETE "$ENV_FILE"); fi
  OBJ_MAX_DELETE=${OBJ_MAX_DELETE:-$OBJECT_MAX_DELETE_DEFAULT}
  printf '%s' "$OBJ_MAX_DELETE" | grep -Eq '^([0-9]{1,9}|off)$' ||
    die "not a deletion limit: $OBJ_MAX_DELETE (a number of objects, or off)"
  return 0
}

# Where a bucket's copy lives offsite: <bucket>[/<prefix>]/media or …/evidence, whatever the
# instance's own bucket names, so a restore into differently named buckets works.
offsite_path() { printf 'caoffsite:%s/%s%s' "$OBJ_DST_BUCKET" "${OBJ_DST_PREFIX:+$OBJ_DST_PREFIX/}" "$1"; }

# This instance's store, as rclone on the host reaches it, into OBJ_SRC_* and OBJ_MEDIA/OBJ_EVIDENCE.
object_source() {
  read_storage_mode "$ENV_FILE"
  OBJ_MEDIA=$(env_get S3_BUCKET_MEDIA "$ENV_FILE")
  OBJ_MEDIA=${OBJ_MEDIA:-commonair-media}
  OBJ_EVIDENCE=$(env_get S3_BUCKET_EVIDENCE "$ENV_FILE")
  OBJ_EVIDENCE=${OBJ_EVIDENCE:-commonair-evidence}
  if [ "$STORAGE_MODE" = external ]; then
    # S3_ENDPOINT is how the containers reach the store; the host may need another address.
    OBJ_SRC_ENDPOINT=$(env_get BACKUP_OBJECTS_SOURCE_ENDPOINT "$ENV_FILE")
    OBJ_SRC_ENDPOINT=${OBJ_SRC_ENDPOINT:-$(env_get S3_ENDPOINT "$ENV_FILE")}
    OBJ_SRC_REGION=$(env_get S3_REGION "$ENV_FILE")
    OBJ_SRC_PATH_STYLE=$(env_get S3_FORCE_PATH_STYLE "$ENV_FILE")
    OBJ_SRC_PATH_STYLE=${OBJ_SRC_PATH_STYLE:-true}
    is_s3_url "${OBJ_SRC_ENDPOINT%/}" || die "the instance's S3 endpoint is not usable from this host: $OBJ_SRC_ENDPOINT" \
      "fix: set BACKUP_OBJECTS_SOURCE_ENDPOINT=https://… in $ENV_FILE"
  else
    OBJ_SRC_ENDPOINT=$GARAGE_HOST_ENDPOINT
    OBJ_SRC_REGION=garage
    OBJ_SRC_PATH_STYLE=true
  fi
  return 0
}

# Sets OBJ_SRC_KEY/OBJ_SRC_SECRET to the env file's pair named $1 and $2, or fails.
use_source_keys() {
  OBJ_SRC_KEY=$(env_get "$1" "$ENV_FILE")
  OBJ_SRC_SECRET=$(env_get "$2" "$ENV_FILE")
  if [ -z "$OBJ_SRC_KEY" ] || [ -z "$OBJ_SRC_SECRET" ]; then die "$ENV_FILE lacks $1 or $2"; fi
  return 0
}

garage_cli() { podman exec commonair-garage /garage "$@"; }

# Garage: a key that can read the media and evidence buckets and nothing else, created on the
# first --objects run and kept in the env file. The secret comes from garage's output through a
# pipe, never an argument. A stored key this Garage does not know (an env file restored onto a
# new server) is replaced.
garage_backup_key() {
  _id=$(env_get BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID "$ENV_FILE")
  _secret=$(env_get BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY "$ENV_FILE")
  if [ -z "$_id" ] || [ -z "$_secret" ] || ! garage_cli key info "$_id" >/dev/null 2>&1; then
    [ -z "$_id" ] || info "this Garage has no key $_id (a restored env file?): creating a new one"
    info "creating the read-only Garage key $OBJECT_BACKUP_KEY_NAME"
    make_tmp
    _out=$(garage_cli key create "$OBJECT_BACKUP_KEY_NAME" 2>"$TMP_ROOT/garage.err") ||
      die "could not create a Garage key: $(tail -n 1 "$TMP_ROOT/garage.err")" \
        "fix: is commonair-garage running? (selfhost.sh status)"
    _id=$(printf '%s\n' "$_out" | sed -n 's/^Key ID:[[:space:]]*//p' | head -n 1)
    _secret=$(printf '%s\n' "$_out" | sed -n 's/^Secret key:[[:space:]]*//p' | head -n 1)
    if ! is_s3_key "$_id" || ! is_s3_key "$_secret"; then
      die "could not read the new key from garage's output" \
        "fix: create it by hand (backups.md, 'Without the script') and set BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID" \
        "and BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY in $ENV_FILE"
    fi
    env_set BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID "$_id"
    env_set BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY "$_secret"
  fi
  # Idempotent, so a run interrupted between create and allow repairs itself.
  for _b in "$OBJ_MEDIA" "$OBJ_EVIDENCE"; do
    garage_cli bucket allow --read "$_b" --key "$_id" >/dev/null 2>&1 ||
      die "could not let the key $_id read $_b" "fix: is commonair-garage running? (selfhost.sh status)"
  done
  OBJ_SRC_KEY=$_id
  OBJ_SRC_SECRET=$_secret
}

# Runs rclone with two remotes defined in its environment only: `cainstance`, this instance's
# store (OBJ_SRC_*), and `caoffsite` (OBJ_DST_*). A subshell, so nothing else this script starts
# inherits the keys. The empty config file keeps an operator's own rclone.conf (a manual setup
# from before the script) out of it. no_check_bucket on both: a key limited to one bucket cannot
# create buckets, and rclone would otherwise try.
rclone_with_remotes() {
  make_tmp
  : >"$TMP_ROOT/rclone.conf"
  (
    export RCLONE_CONFIG="$TMP_ROOT/rclone.conf"
    export RCLONE_CONFIG_CAINSTANCE_TYPE=s3 RCLONE_CONFIG_CAINSTANCE_PROVIDER=Other
    export RCLONE_CONFIG_CAINSTANCE_ENV_AUTH=false RCLONE_CONFIG_CAINSTANCE_NO_CHECK_BUCKET=true
    export RCLONE_CONFIG_CAINSTANCE_ENDPOINT="$OBJ_SRC_ENDPOINT" RCLONE_CONFIG_CAINSTANCE_REGION="$OBJ_SRC_REGION"
    export RCLONE_CONFIG_CAINSTANCE_FORCE_PATH_STYLE="$OBJ_SRC_PATH_STYLE"
    export RCLONE_CONFIG_CAINSTANCE_ACCESS_KEY_ID="$OBJ_SRC_KEY"
    export RCLONE_CONFIG_CAINSTANCE_SECRET_ACCESS_KEY="$OBJ_SRC_SECRET"
    export RCLONE_CONFIG_CAOFFSITE_TYPE=s3 RCLONE_CONFIG_CAOFFSITE_PROVIDER=Other
    export RCLONE_CONFIG_CAOFFSITE_ENV_AUTH=false RCLONE_CONFIG_CAOFFSITE_NO_CHECK_BUCKET=true
    export RCLONE_CONFIG_CAOFFSITE_ENDPOINT="$OBJ_DST_ENDPOINT" RCLONE_CONFIG_CAOFFSITE_REGION="$OBJ_DST_REGION"
    export RCLONE_CONFIG_CAOFFSITE_FORCE_PATH_STYLE="$OBJ_DST_PATH_STYLE"
    export RCLONE_CONFIG_CAOFFSITE_ACCESS_KEY_ID="$OBJ_DST_KEY"
    export RCLONE_CONFIG_CAOFFSITE_SECRET_ACCESS_KEY="$OBJ_DST_SECRET"
    exec rclone "$@"
  )
}

# sync or copy, $2 to $3. --max-delete only for sync (copy deletes nothing); rclone's own limit
# fails the run once reached, so a mass deletion on the instance never empties the copy silently.
rclone_run() {
  _maxdel=""
  if [ "$1" = sync ] && [ "$OBJ_MAX_DELETE" != off ]; then _maxdel="--max-delete=$OBJ_MAX_DELETE"; fi
  # --checksum compares hash and size, which S3 listings carry, instead of a HEAD per object for
  # its modification time; an object without a hash both sides share is compared by size.
  rclone_with_remotes "$1" "$2" "$3" --checksum --stats=1m --stats-one-line --stats-log-level=NOTICE \
    ${_maxdel:+"$_maxdel"} ${OBJ_BWLIMIT:+"--bwlimit=$OBJ_BWLIMIT"}
}

# True when the remote path $1 holds nothing. Exit 3 is rclone's "directory not found": a prefix
# no object was ever written under. Any other failure stops the run ($2 names the place).
remote_is_empty() {
  make_tmp
  if _ls=$(rclone_with_remotes lsf --max-depth 1 "$1" 2>"$TMP_ROOT/rclone-lsf.err"); then
    :
  else
    _rc=$?
    [ "$_rc" -eq 3 ] || die "could not list $2: $(tail -n 1 "$TMP_ROOT/rclone-lsf.err")" \
      "fix: check the store's endpoint and keys in $ENV_FILE, then re-run"
    _ls=""
  fi
  [ -z "$_ls" ]
}

# One --objects or --restore-objects at a time (the daily timer and a run by hand). A lock whose
# holder is gone (killed, the server rebooted) is taken over.
object_lock() {
  mkdir -p "$OBJECT_STATE_DIR"
  if ! ln -s "$$" "$OBJECT_LOCK" 2>/dev/null; then
    _holder=$(readlink "$OBJECT_LOCK" 2>/dev/null || true)
    if [ -n "$_holder" ] && kill -0 "$_holder" 2>/dev/null; then
      die "another object backup or restore is running (pid $_holder)" \
        "wait for it to finish (systemctl --user status commonair-object-backup.service), then re-run"
    fi
    info "taking over the lock of an object backup that is no longer running (pid ${_holder:-unknown})"
    rm -f "$OBJECT_LOCK"
    ln -s "$$" "$OBJECT_LOCK" 2>/dev/null || die "another object backup or restore just started" "re-run once it is done"
  fi
  trap 'object_unlock; cleanup' EXIT
  trap 'exit 1' INT TERM
}

object_unlock() {
  if [ "$(readlink "$OBJECT_LOCK" 2>/dev/null || true)" = "$$" ]; then rm -f "$OBJECT_LOCK"; fi
}

require_rclone() {
  have rclone || die "rclone is not installed (it copies the objects)" \
    "fix: as root, apt install rclone (Debian) or dnf install rclone (Fedora), then re-run"
}

backup_database() {
  info "running commonair-backup.service"
  systemctl --user start commonair-backup.service || die "the backup failed" "see: journalctl --user -u commonair-backup"
  podman exec --user postgres commonair-postgres \
    sh -c '. /usr/local/lib/commonair/walg-env.sh && wal-g backup-list'
}

# The source keys for bucket role $1. Garage: the read-only key (garage_backup_key). External: a
# read-only key if the operator made one (BACKUP_OBJECTS_SOURCE_*), else each bucket's own instance
# key (sync never writes to its source).
backup_source_keys() {
  [ "$STORAGE_MODE" = external ] || return 0
  if [ -n "$(env_get BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID "$ENV_FILE")" ]; then
    use_source_keys BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY
  elif [ "$1" = media ]; then
    use_source_keys S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
  else
    use_source_keys S3_EVIDENCE_ACCESS_KEY_ID S3_EVIDENCE_SECRET_ACCESS_KEY
  fi
}

role_bucket() { if [ "$1" = media ]; then printf '%s' "$OBJ_MEDIA"; else printf '%s' "$OBJ_EVIDENCE"; fi; }

backup_objects() {
  require_rclone
  object_remote
  object_source
  object_lock
  if [ -e "$OBJECT_RESTORE_MARK" ]; then
    die "a backup --restore-objects started on $(cat "$OBJECT_RESTORE_MARK" 2>/dev/null || true) has not finished:" \
      "the instance may lack objects its offsite copy still has, and copying now would delete them there" \
      "fix: run selfhost.sh backup --restore-objects until it succeeds; or, if the instance has" \
      "everything it should, rm $OBJECT_RESTORE_MARK"
  fi
  _first=yes
  [ ! -f "$OBJECT_STATE" ] || _first=no
  if [ "$STORAGE_MODE" != external ]; then garage_backup_key; fi
  # An empty bucket whose copy is not is what a lost Garage volume, a bucket emptied by mistake or
  # --objects typed for --restore-objects looks like: sync would empty the copy. Checked for both
  # buckets before either is copied, so a refusal changes nothing.
  for _role in media evidence; do
    _bucket=$(role_bucket "$_role")
    backup_source_keys "$_role"
    if remote_is_empty "cainstance:$_bucket" "$_bucket" &&
      ! remote_is_empty "$(offsite_path "$_role")" "the offsite copy of $_bucket"; then
      if [ "$ALLOW_EMPTY_SOURCE" = yes ]; then
        warn "$_bucket is empty: its offsite copy will be emptied too (--allow-empty-source)"
      else
        die "$_bucket is empty but its offsite copy is not: refusing to empty the copy" \
          "fix: if the instance lost its objects, restore them: selfhost.sh backup --restore-objects" \
          "(docs/self-hosting/backups.md, 'Restore objects'). If the bucket is empty on purpose:" \
          "selfhost.sh backup --objects --allow-empty-source"
      fi
    fi
  done
  for _role in media evidence; do
    _bucket=$(role_bucket "$_role")
    backup_source_keys "$_role"
    info "copying $_bucket to $OBJ_DST_ENDPOINT, $(offsite_path "$_role" | sed 's/^caoffsite://')"
    rclone_run sync "cainstance:$_bucket" "$(offsite_path "$_role")" ||
      die "copying $_bucket offsite failed" \
        "see the rclone lines above; selfhost.sh status still shows the last successful run." \
        "If rclone stopped at --max-delete ($OBJ_MAX_DELETE): more objects left the instance than the limit." \
        "If that is right, re-run with --max-delete off or a higher number; if not, restore them first."
  done
  record_object_backup
  say "object backup done: $OBJ_MEDIA and $OBJ_EVIDENCE copied to $(object_remote_name)"
  # The first success turns on the daily run; later runs leave the timer as the operator set it.
  if [ "$_first" = yes ]; then
    if systemctl --user enable --now "$OBJECT_TIMER" >/dev/null 2>&1; then
      info "daily object backup on ($OBJECT_TIMER); turn it off with: systemctl --user disable --now $OBJECT_TIMER"
    else
      warn "could not enable $OBJECT_TIMER: run 'systemctl --user enable --now $OBJECT_TIMER' for daily copies"
    fi
  fi
}

# The offsite copy's place, without keys: endpoint/bucket[/prefix].
object_remote_name() { printf '%s/%s%s' "$OBJ_DST_ENDPOINT" "$OBJ_DST_BUCKET" "${OBJ_DST_PREFIX:+/$OBJ_DST_PREFIX}"; }

# Only after every bucket copied: the time and the place, for status and monitoring.
record_object_backup() {
  mkdir -p "$OBJECT_STATE_DIR"
  printf 'LAST_SUCCESS=%s\nREMOTE=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(object_remote_name)" >"$OBJECT_STATE.tmp"
  mv "$OBJECT_STATE.tmp" "$OBJECT_STATE"
}

# For status: when the last object backup succeeded and where to, or why there is none.
object_backup_summary() {
  if [ -f "$OBJECT_STATE" ]; then
    printf '%s (to %s)' "$(env_get LAST_SUCCESS "$OBJECT_STATE")" "$(env_get REMOTE "$OBJECT_STATE")"
  elif [ -n "$(env_get BACKUP_OBJECTS_REMOTE_BUCKET "$ENV_FILE")" ]; then
    printf 'never (selfhost.sh backup --objects)'
  else
    printf 'not configured (docs/self-hosting/backups.md)'
  fi
}

# The offsite copy back into the instance's buckets, with the instance's own keys (they can
# write): the main key for media, the evidence key for evidence. rclone copy, not sync: an object
# the instance has and the copy lacks stays.
restore_objects() {
  require_rclone
  object_remote
  object_source
  object_lock
  # Until every bucket is back, --objects (the daily timer included) is refused.
  if [ ! -e "$OBJECT_RESTORE_MARK" ]; then date -u +%Y-%m-%dT%H:%M:%SZ >"$OBJECT_RESTORE_MARK"; fi
  for _role in media evidence; do
    if [ "$_role" = media ]; then
      _bucket=$OBJ_MEDIA
      use_source_keys S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
    else
      _bucket=$OBJ_EVIDENCE
      use_source_keys S3_EVIDENCE_ACCESS_KEY_ID S3_EVIDENCE_SECRET_ACCESS_KEY
    fi
    info "restoring $_bucket from $OBJ_DST_ENDPOINT, $(offsite_path "$_role" | sed 's/^caoffsite://')"
    rclone_run copy "$(offsite_path "$_role")" "cainstance:$_bucket" ||
      die "restoring $_bucket failed" "see the rclone lines above; re-running it is safe (it copies only what is missing or different)" \
        "until it succeeds, backup --objects is refused so that it cannot delete what is not restored yet"
  done
  rm -f "$OBJECT_RESTORE_MARK"
  say "objects restored into $OBJ_MEDIA and $OBJ_EVIDENCE from $(object_remote_name)"
  say "sealed evidence opens only with the EVIDENCE_PRIVATE_KEY it was sealed with (this env file's, if restored from your copy)"
}

cmd_backup() {
  parse_backup_flags "$@"
  require_instance backup
  if [ "$RESTORE_OBJECTS" = yes ]; then
    restore_objects
    return 0
  fi
  if [ "$BACKUP_DATABASE" = yes ]; then backup_database; fi
  if [ "$BACKUP_OBJECTS" = yes ]; then backup_objects; fi
  return 0
}
cmd_status() {
  require_instance status
  say "version:   $(installed_version) ($(readlink "$CURRENT_LINK"))"
  if [ -L "$PREVIOUS_LINK" ]; then say "previous:  $(env_get COMMONAIR_VERSION "$PREVIOUS_LINK/release.env")"; fi
  _tls=$(env_get TLS_MODE "$ENV_FILE")
  say "host:      $(env_get PUBLIC_HOSTNAME "$ENV_FILE")  tls: ${_tls:-acme}"
  if [ "${_tls:-acme}" = internal ]; then say "root CA:   $(caddy_root_path)"; fi
  _exp=$(cert_expiry)
  if [ -n "$_exp" ]; then say "cert:      expires $_exp"; fi
  read_storage_mode "$ENV_FILE"
  if [ "$STORAGE_MODE" = external ]; then
    say "storage:   external S3 at $(env_get S3_ENDPOINT "$ENV_FILE") (region $(env_get S3_REGION "$ENV_FILE"), path style $(env_get S3_FORCE_PATH_STYLE "$ENV_FILE"))"
    storage_check
  else
    say "storage:   Garage on this host (commonair-garage)"
  fi
  read_state_mode "$ENV_FILE"
  if [ "$STATE_MODE" = external ]; then
    _sdb=$(env_get DATABASE_OWNER_URL "$ENV_FILE")
    _svk=$(env_get VALKEY_URL "$ENV_FILE")
    say "state:     external Postgres at $(pg_place "$_sdb"), external Valkey at $(url_endpoint "$_svk" 6379)"
  fi
  # Whether coturn runs and the relay is on; never the secret or the credentials.
  _coturn=$(systemctl --user show commonair-coturn.service --property=ActiveState --value 2>/dev/null || true)
  if [ -n "$(env_get P2P_TURN_URLS "$ENV_FILE")" ]; then
    _turn_relay="on (UDP $(turn_relay_range))"
  else
    _turn_relay="off"
  fi
  say "p2p:       coturn ${_coturn:-?} (STUN 3478/udp), TURN relay $_turn_relay"
  if captions_on; then
    _whisper=$(systemctl --user show commonair-whisper.service --property=ActiveState --value 2>/dev/null || true)
    _cap_max=$(env_get CAPTIONS_MAX_STREAMS "$ENV_FILE")
    say "captions:  on, commonair-whisper ${_whisper:-?}, up to ${_cap_max:-2} streams (CAPTIONS_MAX_STREAMS)"
  else
    say "captions:  off"
  fi
  seed_mode_status
  say ""
  say "units:"
  for _u in $(all_units); do
    _state=$(systemctl --user show "$_u" --property=ActiveState --value 2>/dev/null || true)
    _sub=$(systemctl --user show "$_u" --property=SubState --value 2>/dev/null || true)
    _c=$(sed -n 's/^ContainerName=//p' "$QUADLET_DIR/${_u%.service}.container")
    _h=$(podman inspect --format '{{.State.Health.Status}}' "$_c" 2>/dev/null || true)
    printf '  %-34s %-10s %-10s %s\n' "${_u%.service}" "${_state:-?}" "${_sub:-?}" "${_h:--}"
  done
  # External Postgres and Valkey run no unit here: "external" and what the servers answer.
  if [ "$STATE_MODE" = external ]; then state_status; fi
  for _u in $(sockets); do
    _state=$(systemctl --user show "$_u" --property=ActiveState --value 2>/dev/null || true)
    _sub=$(systemctl --user show "$_u" --property=SubState --value 2>/dev/null || true)
    printf '  %-34s %-10s %-10s %s\n' "$_u" "${_state:-?}" "${_sub:-?}" "-"
  done
  say ""
  if [ "$STATE_MODE" != external ]; then
    _last=$(systemctl --user show commonair-backup.service --property=ExecMainExitTimestamp --value 2>/dev/null || true)
    _res=$(systemctl --user show commonair-backup.service --property=Result --value 2>/dev/null || true)
    say "last backup: ${_last:-never} (${_res:-?})"
  else
    say "last backup: the provider's (external Postgres; docs/self-hosting/managed-services.md)"
  fi
  say "last object backup: $(object_backup_summary)"
  say ""
  say "volumes:"
  for _v in $(podman volume ls --quiet --filter name=commonair- 2>/dev/null); do
    _mp=$(podman volume inspect "$_v" --format '{{.Mountpoint}}' 2>/dev/null || true)
    _sz=$(podman unshare du -sh "$_mp" 2>/dev/null | awk '{print $1}' || true)
    printf '  %-28s %s\n' "$_v" "${_sz:-?}"
  done
}

# --- staging reset ------------------------------------------------------------------------
#
# `seed full` writes append-only rows (ledger, co-op, votes, audit) that only a database reset
# removes (ADR 0004), so staging is reset by hand and reseeded. Staging runs NODE_ENV=production
# like any instance; what marks it is DEMO_SEED_FULL=true in commonair.env, the full seed's own
# guard flag, which a production instance never sets. --confirm with the exact hostname guards
# against a shell on the wrong host.

# Stay up through the reset: the database lives in Postgres, the caches in Valkey, and objects
# are kept (stale VODs and clips are harmless; the next seed writes new ones).
RESET_KEEP="commonair-postgres.service commonair-valkey.service commonair-garage.service"

parse_reset_flags() {
  RESET_CONFIRM=""
  RESET_BASE_SEED=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --confirm)
        [ $# -ge 2 ] && [ -n "$2" ] || die "--confirm needs a value (this instance's PUBLIC_HOSTNAME)"
        RESET_CONFIRM=$2
        shift 2
        ;;
      --base-seed) RESET_BASE_SEED=yes && shift ;;
      -h | --help) usage && exit 0 ;;
      *) die "unknown reset-staging option: $1" "see: selfhost.sh --help" ;;
    esac
  done
  return 0
}

# reset-staging and seed mode drop and flush the bundled containers' data; a staging instance runs
# bundled state, and an external database is not this script's to drop.
refuse_external_state() {
  read_state_mode "$ENV_FILE"
  [ "$STATE_MODE" != external ] || die "$1 refused: this instance uses external Postgres and Valkey; it works on the bundled ones only. Nothing was changed." \
    "staging instances run the bundled Postgres and Valkey (docs/self-hosting/managed-services.md)"
}

# Refuses, before anything is touched, unless this is a staging instance and the operator named it
# ($1: the command, for the messages; $2: what --confirm gave).
staging_guard() {
  _sg_cmd=${1:-reset-staging}
  _sg_confirm=${2-$RESET_CONFIRM}
  _flag=$(env_get DEMO_SEED_FULL "$ENV_FILE")
  case "$_flag" in
    true | 1) ;;
    *)
      die "$_sg_cmd refused: DEMO_SEED_FULL is ${_flag:-unset} in $ENV_FILE, not true" \
        "only a local or staging instance sets it; a production instance is never reset or seeded. Nothing was changed."
      ;;
  esac
  _host=$(env_get PUBLIC_HOSTNAME "$ENV_FILE")
  [ -n "$_host" ] || die "$_sg_cmd refused: $ENV_FILE has no PUBLIC_HOSTNAME. Nothing was changed."
  [ -n "$_sg_confirm" ] || die "$_sg_cmd refused: pass --confirm $_host to name this instance. Nothing was changed."
  [ "$_sg_confirm" = "$_host" ] ||
    die "$_sg_cmd refused: --confirm $_sg_confirm is not this instance ($_host). Nothing was changed."
}

# Postgres and Valkey up and healthy (they normally never stopped).
reset_wait_data() {
  systemctl --user start --no-block commonair-postgres.service commonair-valkey.service 2>/dev/null || true
  _deadline=$(($(date +%s) + HEALTH_TIMEOUT))
  until unit_healthy commonair-postgres.service && unit_healthy commonair-valkey.service; do
    [ "$(date +%s)" -lt "$_deadline" ] ||
      die "Postgres or Valkey is not healthy after ${HEALTH_TIMEOUT}s; the app units are stopped" \
        "see: selfhost.sh status; once they are healthy, re-run reset-staging"
    sleep "$POLL_INTERVAL"
  done
}

cmd_reset_staging() {
  parse_reset_flags "$@"
  require_instance reset-staging
  refuse_external_state reset-staging
  staging_guard
  _host=$(env_get PUBLIC_HOSTNAME "$ENV_FILE")
  warn "resetting $_host: every row in its database is deleted, with no backup first"

  # 1. the app units down (sockets first, so a connection cannot start Caddy again)
  _stop=""
  for _u in $(sockets) $(all_units); do
    case " $RESET_KEEP " in *" $_u "*) continue ;; esac
    _stop="$_stop $_u"
  done
  info "stopping the app units"
  # shellcheck disable=SC2086 # unit names have no spaces
  systemctl --user stop $_stop || die "could not stop the app units; the database was not touched" \
    "see: selfhost.sh status"
  reset_wait_data

  # 2. a new, empty database, as the owner role (FORCE ends any connection left)
  info "dropping and recreating the commonair database"
  podman exec --user postgres commonair-postgres psql -X -q -v ON_ERROR_STOP=1 -U commonair -d postgres \
    -c 'DROP DATABASE IF EXISTS commonair WITH (FORCE)' -c 'CREATE DATABASE commonair OWNER commonair' ||
    die "dropping or recreating the database failed; the app units are stopped" \
      "see: journalctl --user -u commonair-postgres; re-running reset-staging is safe"

  # 3. sessions, queues and caches that name the old rows
  info "flushing Valkey"
  # shellcheck disable=SC2016 # expanded inside the container, where VALKEY_PASSWORD is set
  podman exec commonair-valkey sh -c 'export VALKEYCLI_AUTH="$VALKEY_PASSWORD"; valkey-cli FLUSHALL | grep -qx OK' ||
    die "flushing Valkey failed; the database is already empty and the app units are stopped" \
      "see: journalctl --user -u commonair-valkey; re-running reset-staging is safe"

  # 4. migrations and the app role, as install and upgrade run them (GOVERNANCE_BOOTSTRAP_JSON too)
  systemctl --user reset-failed 'commonair-*' 2>/dev/null || true
  info "running migrations (commonair-migrate)"
  start_migrate || die "migrations failed on the empty database; the app units are stopped" \
    "see: journalctl --user -u commonair-migrate"

  # 5. optionally the basic demo tier, from the release's tools image (packages/db/src/demo)
  if [ "$RESET_BASE_SEED" = yes ]; then
    info "running the basic demo seed (demo:seed)"
    # DEMO_SEED_PASSWORD passes by name from this shell, never on the command line.
    _pw_env=""
    if [ -n "${DEMO_SEED_PASSWORD:-}" ]; then _pw_env=--env=DEMO_SEED_PASSWORD; fi
    podman run --rm --network commonair \
      --secret commonair-owner-database-url,type=env,target=DATABASE_URL ${_pw_env:+"$_pw_env"} \
      "$(tools_image "$CURRENT_LINK")" bun packages/db/src/demo/cli.ts seed ||
      die "the demo seed failed; the database is migrated, the app units are stopped" \
        "start them with: systemctl --user start $(services | tr '\n' ' ')"
  fi

  # 6. everything back, and healthy
  info "starting the stack"
  # shellcheck disable=SC2046
  systemctl --user start --no-block $(sockets) $(services)
  wait_healthy core || die "the instance did not become healthy after the reset" \
    "see: selfhost.sh status, and journalctl --user -u 'commonair-*'"
  if first_irc_cert; then wait_healthy all || warn "IRC is not healthy yet (selfhost.sh status)"; fi

  say ""
  say "Reset $_host: new empty database, migrated; Valkey flushed; units healthy."
  if [ "$RESET_BASE_SEED" = yes ]; then
    say "The basic demo seed ran (its accounts are listed above)."
  fi
  say "Not reset: object storage. VODs and clips in the media bucket stay; they are harmless,"
  say "and the next seed writes new ones."
  if [ "$RESET_BASE_SEED" = yes ]; then
    say "seed full refuses a database with users, so it cannot run on top of the basic seed."
  elif seed_mode_open; then
    say ""
    say "Seed mode is open (until $(env_get DEADLINE_UTC "$SEED_STATE")), and the migrations applied its"
    say "governance bootstrap. Next, fill the database from the seed harness on this host:"
    say "  sh ~/commonair/selfhost.sh seed-mode run --confirm $_host --scale medium"
  else
    say ""
    say "Next: fill it with the full seed, from a repository checkout whose DATABASE_URL reaches"
    say "this database (Postgres is not published on the host: run the harness on the commonair"
    say "network, where it is postgres:5432/commonair, or forward a port) and whose HARNESS_*_URL"
    say "point at https://$_host:"
    say "  DEMO_SEED_FULL=true bun harness/src/cli.ts seed full --confirm postgres:5432/commonair --scale medium"
    say "--confirm is DATABASE_URL's host:port/database exactly (127.0.0.1:<port>/commonair through"
    say "a forwarded port). That stack needs the seed's test hooks and mocks: on this host, open"
    say "seed mode first (selfhost.sh seed-mode open, then reset-staging again; docs/testing/seeding.md)."
  fi
}

# --- staging seed mode (ADR 0040) ----------------------------------------------------------
#
# `seed full` needs what no real instance has: every test hook, insecure outbound settings, the
# scripted classifier with the synthetic hash lists, stripe-mock, an SMTP sink, and peers (webhook
# sinks, an ActivityPub peer, the Twitch mock, an RTMP sink, a member relay) that the stack calls
# back. Seed mode is a time-limited state of a staging instance that has them:
#
# - `open` first arms a timer that closes seed mode at the deadline (6 hours at most; open fails,
#   changing nothing, if it does not arm), then saves the previous value of every key it changes
#   (SEED_STATE, mode 0600), writes the seed-mode keys into commonair.env as one marked block, turns the giveaways, the watch gate, the
#   surge guard and push on, adds drop-ins to the api, worker and media units (what those units pin
#   themselves: the hash lists, and for the API the harness's fixed address as a trusted proxy),
#   installs the stripe-mock, Mailpit and seed-harness units (unit_in_mode lets them in only while
#   SEED_STATE exists), and restarts what reads the changed keys.
# - `run` and `coverage` run the harness in the seed-harness container, on the commonair network.
#   After `seed full`, `run` starts `seed live` there detached (`podman exec -d`): a few seeded
#   channels stream with chat until `close` stops it (SIGTERM), before the container stops.
# - `close` removes the block, restores exactly the saved values, removes the units, the drop-ins
#   and the timer, and restarts. The features above stay on; the seeded data stays.
# - One open or close runs at a time (SEED_LOCK); a close while another holds it changes nothing.
#
# Nothing is published on the host, and every peer the stack calls is a container on its network.

SEED_STATE="$OBJECT_STATE_DIR/seed-mode"
SEED_DATA_DIR="$DATA_DIR/seed-mode"
SEED_MAX_HOURS=6
# The harness container's name on the network, and its fixed address (the API trusts it as a
# proxy in seed mode: infra/selfhost/seed-mode/commonair-api.conf).
SEED_HARNESS_HOST=seed-harness
SEED_UNITS="commonair-stripe-mock.container commonair-mailpit.container commonair-seed-harness.container"
# Units the release ships a seed-mode drop-in for (infra/selfhost/seed-mode/commonair-<unit>.conf).
SEED_DROPIN_UNITS="api worker media"
SEED_DROPIN=50-seed-mode.conf
SEED_TIMER=commonair-seed-mode-close.timer
# One open or close at a time (the timer's close and one by hand): a symlink to the holder's pid.
SEED_LOCK="$OBJECT_STATE_DIR/seed-mode.lock"
SEED_CLOSE_SERVICE=commonair-seed-mode-close.service
# `seed live` in the harness container: how many channels, and its pid and log in the reports
# volume (the pid is the container's; only commands run in the container use it).
SEED_LIVE_CHANNELS=3
SEED_LIVE_PID=/reports/seed-live.pid
SEED_LIVE_LOG=seed-live.log
SEED_BLOCK_BEGIN="# >>> staging seed mode: selfhost.sh seed-mode close removes this block and restores the values it replaced >>>"
SEED_BLOCK_END="# <<< staging seed mode <<<"
# Turned on by open and left on by close (decision 2).
SEED_KEEP_ON="GIVEAWAYS_ENABLED=true CHAT_WATCH_GATE=on CHAT_SURGE_GUARD=on WEB_PUSH_ENABLED=true"
# DATABASE_URL's host:port/database inside the network (create_secrets), for seed full's --confirm.
SEED_DB_TARGET="postgres:5432/commonair"
# The database dumped after each seed unit (run --from restores one), next to the harness's
# checkpoints (seed-checkpoint-<unit>.json) in the reports volume.
SEED_SNAP_DIR="$SEED_DATA_DIR/reports/snapshots"

seed_mode_open() { [ -f "$SEED_STATE" ]; }

# The pid of a live open or close holding the lock, else nothing.
seed_lock_holder() {
  _holder=$(readlink "$SEED_LOCK" 2>/dev/null || true)
  if [ -n "$_holder" ] && kill -0 "$_holder" 2>/dev/null; then printf '%s' "$_holder"; fi
}

# Takes the lock, or returns 1 when a live open or close holds it. A stale lock (its holder
# killed, the host rebooted) is taken over.
seed_lock() {
  mkdir -p "$OBJECT_STATE_DIR"
  if ! ln -s "$$" "$SEED_LOCK" 2>/dev/null; then
    [ -z "$(seed_lock_holder)" ] || return 1
    rm -f "$SEED_LOCK"
    ln -s "$$" "$SEED_LOCK" 2>/dev/null || return 1
  fi
  trap 'seed_unlock; cleanup' EXIT
  trap 'exit 1' INT TERM
}

seed_unlock() {
  if [ "$(readlink "$SEED_LOCK" 2>/dev/null || true)" = "$$" ]; then rm -f "$SEED_LOCK"; fi
}

# The block's keys and values ($1: the webhook secret the harness signs stripe-mock's events with).
# The same values as the compose overrides the local seed stack layers (scripts/infra.ts
# HARNESS_OVERRIDES, W3_OVERRIDES, SEED_OVERRIDE), with every peer at the harness container instead
# of host.containers.internal; scripts/tests/selfhost-seed-mode-parity.test.ts keeps them equal.
seed_block_body() {
  cat <<EOF
COOP_TEST_HOOKS=true
INTERACT_TEST_HOOKS=true
MODERATION_TEST_HOOKS=true
OPS_TEST_HOOKS=true
MODERATION_CLASSIFIER=scripted
MODERATION_SAMPLE_SECONDS=2
OUTBOUND_ALLOW_PRIVATE_NETWORKS=true
EVENTSUB_ALLOW_INSECURE_CALLBACKS=true
WEB_PUSH_ALLOW_INSECURE_ENDPOINTS=true
FEDERATION_ENABLED=true
TWITCH_IMPORT_ENABLED=true
OAUTH_TWITCH_CLIENT_ID=harness-twitch-client-id
OAUTH_TWITCH_CLIENT_SECRET=harness-twitch-client-secret
TWITCH_API_BASE_URL=http://$SEED_HARNESS_HOST:4791/helix
TWITCH_AUTH_BASE_URL=http://$SEED_HARNESS_HOST:4791/oauth2
TWITCH_IMAGE_HOSTS=$SEED_HARNESS_HOST
PAYMENTS_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_harnessseed
STRIPE_API_BASE=http://stripe-mock:12111
STRIPE_WEBHOOK_SECRET=$1
INFRA_COST_MODEL={"currency":"usd","centsPerGb":{"origin":5000,"relay":2000,"p2p":0,"cdn":8000}}
GOVERNANCE_BOOTSTRAP_JSON={"governance.protections":{"councilReviewSeconds":30,"minVotingSeconds":45,"quorum":0.01,"streamerClassQuorum":0.01},"governance.ordinary":{"discussionSeconds":30,"minVotingSeconds":45,"votingSeconds":45,"quorum":0.01},"membership.classes":{"streamer":{"minStreamingHours":0.01,"windowDays":90,"minVerifiedViewers":2,"lapseGraceDays":14},"viewer":{"shareCents":500,"shareRefundableOnExit":true,"activeSubscriptionQualifies":true,"minSubscriptionCents":300},"worker":{"appointedBy":"board"}},"council.config":{"size":50,"minStreamingHours":0.01},"interact.points.accrual":{"pointsPerBlock":10,"blockMinutes":1,"dailyCapPerChannel":1000},"notifications.goLive":{"cooldownHours":4,"emailDigestMinutes":1}}
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_REQUIRE_TLS=false
SMTP_USER=
SMTP_PASSWORD=
EOF
}

seed_block_keys() { seed_block_body x | sed 's/=.*//' | tr '\n' ' '; }
seed_keep_keys() { for _kv in $SEED_KEEP_ON; do printf '%s ' "${_kv%%=*}"; done; }

# Epoch seconds as UTC, ISO 8601 or as systemd's calendar ($2 = calendar); GNU date, else BSD's.
seed_utc() {
  _fmt=%Y-%m-%dT%H:%M:%SZ
  [ "${2:-}" != calendar ] || _fmt='%Y-%m-%d %H:%M:%S UTC'
  date -u -d "@$1" "+$_fmt" 2>/dev/null || date -u -r "$1" "+$_fmt"
}

# Rewrites commonair.env without the seed-mode block and, outside it, without the lines of the
# keys in $1 (space-separated). Keys and markers reach awk through its environment.
seed_env_rewrite() {
  _tmp="$ENV_FILE.tmp"
  (
    umask 077
    SEED_BEGIN="$SEED_BLOCK_BEGIN" SEED_END="$SEED_BLOCK_END" SEED_DROP="$1" awk '
      BEGIN { n = split(ENVIRON["SEED_DROP"], ks, " "); for (i = 1; i <= n; i++) drop[ks[i]] = 1; inblock = 0 }
      $0 == ENVIRON["SEED_BEGIN"] { inblock = 1; next }
      inblock && $0 == ENVIRON["SEED_END"] { inblock = 0; next }
      inblock { next }
      /^[A-Za-z_][A-Za-z0-9_]*=/ { k = substr($0, 1, index($0, "=") - 1); if (k in drop) next }
      { print }
    ' "$ENV_FILE" >"$_tmp"
  )
  chmod 600 "$_tmp"
  mv "$_tmp" "$ENV_FILE"
}

seed_block_present() { [ -f "$ENV_FILE" ] && grep -qxF "$SEED_BLOCK_BEGIN" "$ENV_FILE"; }

# The app units to restart after the seed-mode keys changed: every installed unit whose key list
# names one of them (render-env passes it on its next start), and the units with a drop-in.
seed_affected_units() {
  _keys="$(seed_block_keys)$(seed_keep_keys)"
  (
    for _f in "$CURRENT_LINK"/infra/selfhost/env/commonair-*.keys; do
      [ -f "$_f" ] || continue
      _u=$(basename "$_f" .keys)
      case "$_u" in commonair-migrate | commonair-seed-harness) continue ;; esac
      [ -f "$QUADLET_DIR/$_u.container" ] || continue
      for _k in $_keys; do
        if grep -qxF "$_k" "$_f"; then
          printf '%s.service\n' "$_u"
          break
        fi
      done
    done
    for _u in $SEED_DROPIN_UNITS; do printf 'commonair-%s.service\n' "$_u"; done
  ) | sort -u | tr '\n' ' '
}

# Refuses $1 (upgrade, install --reinstall) while seed mode is open: it would install units that
# leave the seed-mode ones and their drop-ins out, under a block meant to be closed first.
refuse_while_seed_mode() {
  seed_mode_open || seed_block_present || return 0
  die "$1 refused: staging seed mode is open (until $(env_get DEADLINE_UTC "$SEED_STATE" 2>/dev/null || true)). Nothing was changed." \
    "fix: close it first: sh $CURRENT_LINK/selfhost.sh seed-mode close (the seeded data stays), then re-run"
}

parse_seed_flags() {
  SEED_CONFIRM=""
  SEED_HOURS=$SEED_MAX_HOURS
  SEED_SCALE=medium
  SEED_N=1
  SEED_FROM=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --confirm | --hours | --scale | --seed | --from)
        [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
        case "$1" in
          --confirm) SEED_CONFIRM=$2 ;;
          --hours) SEED_HOURS=$2 ;;
          --scale) SEED_SCALE=$2 ;;
          --seed) SEED_N=$2 ;;
          --from) SEED_FROM=$2 ;;
        esac
        shift 2
        ;;
      -h | --help) usage && exit 0 ;;
      *) die "unknown seed-mode option: $1" "see: selfhost.sh --help" ;;
    esac
  done
  case "$SEED_HOURS" in
    [1-9] | [1-9][0-9]) ;;
    *) die "--hours must be a whole number of hours from 1 to $SEED_MAX_HOURS, not $SEED_HOURS" ;;
  esac
  [ "$SEED_HOURS" -le "$SEED_MAX_HOURS" ] ||
    die "--hours $SEED_HOURS is longer than seed mode may stay open ($SEED_MAX_HOURS hours)" \
      "seed mode turns on test hooks and insecure settings; open it again later if a run needs more time"
  case "$SEED_SCALE" in small | medium) ;; *) die "--scale must be small or medium, not $SEED_SCALE" ;; esac
  case "$SEED_N" in *[!0-9]*) die "--seed must be a whole number, not $SEED_N" ;; esac
  case "$SEED_FROM" in *[!a-z]*) die "--from must be a seed unit's name (selfhost.sh --help), not $SEED_FROM" ;; esac
  return 0
}

# 32 random bytes as hex, from the kernel (od reads them; nothing reaches an argument list).
seed_random_hex() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

# The units' timer and service, written by open and removed by close. Persistent=true: a deadline
# missed while the host was down closes seed mode as soon as it is back up.
seed_write_timer() {
  {
    say "# Written by selfhost.sh seed-mode open; seed-mode close removes it (ADR 0040)."
    say "[Unit]"
    say "Description=Close CommonAir's staging seed mode at its deadline"
    say ""
    say "[Timer]"
    say "OnCalendar=$1"
    say "Persistent=true"
    say "AccuracySec=1min"
    say "Unit=$SEED_CLOSE_SERVICE"
    say ""
    say "[Install]"
    say "WantedBy=timers.target"
  } >"$SYSTEMD_DIR/$SEED_TIMER"
  {
    say "# Written by selfhost.sh seed-mode open; seed-mode close removes it (ADR 0040)."
    say "[Unit]"
    say "Description=Close CommonAir's staging seed mode"
    say ""
    say "[Service]"
    say "Type=oneshot"
    say "ExecStart=/bin/sh %h/commonair/selfhost.sh seed-mode close"
    say "TimeoutStartSec=3600"
  } >"$SYSTEMD_DIR/$SEED_CLOSE_SERVICE"
}

# The harness's own drop-in: PUBLIC_HOSTNAME resolves to this host (where Caddy's sockets listen),
# so presigned uploads, playback URLs and the web app work from the container, and the Origin the
# harness sends is the instance's own.
seed_write_harness_dropin() {
  _d="$QUADLET_DIR/commonair-seed-harness.container.d"
  mkdir -p "$_d"
  {
    say "# Written by selfhost.sh seed-mode open; seed-mode close removes it (ADR 0040)."
    say "[Container]"
    say "AddHost=$1:host-gateway"
    say "Environment=HARNESS_WEB_URL=https://$1"
    if [ "$(env_get TLS_MODE "$ENV_FILE")" = internal ]; then
      say "# TLS_MODE=internal: Caddy's own CA, which the harness does not know."
      say "Environment=NODE_TLS_REJECT_UNAUTHORIZED=0"
    fi
  } >"$_d/$SEED_DROPIN"
}

seed_remove_dropins() {
  for _u in $SEED_DROPIN_UNITS seed-harness; do
    _d="$QUADLET_DIR/commonair-$_u.container.d"
    rm -f "$_d/$SEED_DROPIN"
    # The directory only if seed mode made it (an operator's own drop-ins stay).
    rmdir "$_d" 2>/dev/null || true
  done
}

seed_services() { for _u in $SEED_UNITS; do printf '%s.service ' "${_u%.container}"; done; }

cmd_seed_mode_open() {
  parse_seed_flags "$@"
  require_instance "seed-mode open"
  refuse_external_state "seed-mode open"
  staging_guard "seed-mode open" "$SEED_CONFIRM"
  seed_lock || die "seed-mode open refused: another seed-mode open or close is running (pid $(seed_lock_holder)). Nothing was changed." \
    "wait for it to finish (systemctl --user status $SEED_CLOSE_SERVICE), then re-run"
  _host=$(env_get PUBLIC_HOSTNAME "$ENV_FILE")
  is_hostname "$_host" || die "seed-mode open refused: PUBLIC_HOSTNAME in $ENV_FILE is not a hostname. Nothing was changed."
  if seed_mode_open; then
    die "seed-mode open refused: seed mode is already open, until $(env_get DEADLINE_UTC "$SEED_STATE"). Nothing was changed." \
      "close it first (sh $CURRENT_LINK/selfhost.sh seed-mode close) to open it with a new deadline"
  fi
  seed_block_present && die "seed-mode open refused: $ENV_FILE has a seed-mode block but seed mode is not open. Nothing was changed." \
    "fix: sh $CURRENT_LINK/selfhost.sh seed-mode close removes it, then re-run"
  read_storage_mode "$ENV_FILE"
  captions_on || die "seed-mode open refused: live captions are off on this instance. Nothing was changed." \
    "the seed records captioned broadcasts: install with --captions first (sh $CURRENT_LINK/selfhost.sh install --reinstall --captions)"
  if [ -z "$(env_get VAPID_PUBLIC_KEY "$ENV_FILE")" ] || [ -z "$(env_get VAPID_PRIVATE_KEY "$ENV_FILE")" ]; then
    die "seed-mode open refused: $ENV_FILE lacks the VAPID key pair, and seed mode turns push on. Nothing was changed." \
      "fix: delete both VAPID_* lines and run sh $CURRENT_LINK/selfhost.sh install --reinstall (it generates a new pair)"
  fi
  for _f in $SEED_UNITS; do
    [ -n "$(release_unit_path "$CURRENT_LINK" "$_f")" ] ||
      die "seed-mode open refused: release $(installed_version) has no seed mode ($_f is missing). Nothing was changed." \
        "fix: upgrade to a release that ships it"
  done
  for _u in $SEED_DROPIN_UNITS; do
    [ -f "$CURRENT_LINK/infra/selfhost/seed-mode/commonair-$_u.conf" ] ||
      die "seed-mode open refused: release $(installed_version) has no seed-mode drop-in for $_u. Nothing was changed."
  done

  # Pull first: a pull that fails leaves the instance as it was.
  for _f in $SEED_UNITS; do pull_one "$(sed -n 's/^Image=//p' "$(release_unit_path "$CURRENT_LINK" "$_f")" | head -n 1)"; done

  _now=$(date -u +%s)
  _deadline=$((_now + SEED_HOURS * 3600))
  _deadline_utc=$(seed_utc "$_deadline")
  warn "opening seed mode on $_host until $_deadline_utc: test hooks, insecure outbound settings and mocks are ON"

  # 1. The close timer, armed before anything changes: whatever stops open from here on, the
  #    deadline closes it. One that does not arm leaves the instance as it was.
  mkdir -p "$SYSTEMD_DIR"
  seed_write_timer "$(seed_utc "$_deadline" calendar)"
  systemctl --user daemon-reload
  if ! systemctl --user enable --now "$SEED_TIMER" >/dev/null 2>&1; then
    systemctl --user disable --now "$SEED_TIMER" >/dev/null 2>&1 || true
    rm -f "$SYSTEMD_DIR/$SEED_TIMER" "$SYSTEMD_DIR/$SEED_CLOSE_SERVICE"
    systemctl --user daemon-reload || true
    die "seed-mode open failed: could not arm $SEED_TIMER, so nothing would close seed mode. Nothing was changed." \
      "see: systemctl --user status $SEED_TIMER, then re-run"
  fi

  # 2. The values this changes, saved before anything changes (close restores exactly these).
  mkdir -p "$OBJECT_STATE_DIR"
  _keys=$(seed_block_keys)
  (
    umask 077
    {
      printf 'OPENED_AT=%s\n' "$(seed_utc "$_now")"
      printf 'DEADLINE=%s\n' "$_deadline"
      printf 'DEADLINE_UTC=%s\n' "$_deadline_utc"
      for _k in $_keys; do
        if grep -q "^$_k=" "$ENV_FILE"; then printf 'PREV_%s=%s\n' "$_k" "$(env_get "$_k" "$ENV_FILE")"; fi
      done
    } >"$SEED_STATE.tmp"
  )
  chmod 600 "$SEED_STATE.tmp"
  mv "$SEED_STATE.tmp" "$SEED_STATE"

  # 3. commonair.env: the block replaces those keys; the features that stay on are plain lines.
  seed_env_rewrite "$_keys"
  _whsec="whsec_$(seed_random_hex)"
  {
    printf '%s\n' "$SEED_BLOCK_BEGIN"
    seed_block_body "$_whsec"
    printf '%s\n' "$SEED_BLOCK_END"
  } >>"$ENV_FILE"
  for _kv in $SEED_KEEP_ON; do env_set "${_kv%%=*}" "${_kv#*=}"; done

  # 4. Units and drop-ins.
  mkdir -p "$SEED_DATA_DIR/reports"
  for _f in $SEED_UNITS; do cp "$(release_unit_path "$CURRENT_LINK" "$_f")" "$QUADLET_DIR/"; done
  for _u in $SEED_DROPIN_UNITS; do
    mkdir -p "$QUADLET_DIR/commonair-$_u.container.d"
    cp "$CURRENT_LINK/infra/selfhost/seed-mode/commonair-$_u.conf" "$QUADLET_DIR/commonair-$_u.container.d/$SEED_DROPIN"
  done
  seed_write_harness_dropin "$_host"
  systemctl --user daemon-reload

  # 5. The mocks, then what reads the changed keys, then the harness.
  info "starting stripe-mock and Mailpit, restarting $(seed_affected_units)"
  systemctl --user start commonair-stripe-mock.service commonair-mailpit.service ||
    warn "stripe-mock or Mailpit did not start (selfhost.sh status)"
  # shellcheck disable=SC2046 # unit names have no spaces
  systemctl --user restart $(seed_affected_units) || warn "a restart failed (selfhost.sh status)"
  systemctl --user start --no-block commonair-seed-harness.service || true
  wait_healthy core || die "seed mode is open but the instance is not healthy" \
    "see: selfhost.sh status, and journalctl --user -u 'commonair-*'" \
    "close it with: sh $CURRENT_LINK/selfhost.sh seed-mode close"

  say ""
  say "Seed mode is OPEN on $_host until $_deadline_utc ($SEED_HOURS h); $SEED_TIMER closes it then."
  say "Email goes to Mailpit, payments to stripe-mock, and every test hook is on until it closes."
  say "Next, in order:"
  say "  sh $CURRENT_LINK/selfhost.sh reset-staging --confirm $_host"
  say "  sh $CURRENT_LINK/selfhost.sh seed-mode run --confirm $_host --scale medium"
  say "  sh $CURRENT_LINK/selfhost.sh seed-mode close"
}

# Refuses a run after the deadline: the timer is about to close seed mode, or failed to.
seed_require_open() {
  seed_mode_open || die "$1 refused: seed mode is not open" \
    "fix: sh $CURRENT_LINK/selfhost.sh seed-mode open --confirm $(env_get PUBLIC_HOSTNAME "$ENV_FILE")"
  _dl=$(env_get DEADLINE "$SEED_STATE")
  [ "$(date -u +%s)" -lt "${_dl:-0}" ] ||
    die "$1 refused: seed mode's deadline ($(env_get DEADLINE_UTC "$SEED_STATE")) has passed" \
      "fix: sh $CURRENT_LINK/selfhost.sh seed-mode close, then open it again"
  unit_healthy commonair-seed-harness.service ||
    die "$1 refused: the seed harness (commonair-seed-harness) is not running and healthy" \
      "see: selfhost.sh status, and journalctl --user -u commonair-seed-harness"
}

# podman exec in the harness container; DEMO_SEED_PASSWORD passes by name from this shell, never
# on a command line.
seed_exec() {
  _pw_env=""
  if [ -n "${DEMO_SEED_PASSWORD:-}" ]; then _pw_env=--env=DEMO_SEED_PASSWORD; fi
  podman exec ${_pw_env:+"$_pw_env"} commonair-seed-harness "$@"
}

# `seed live` runs detached in the harness container until seed-mode close. It needs the password
# `seed full` used (DEMO_SEED_PASSWORD, by name). The single-quoted scripts run in the container.
seed_live_running() {
  # shellcheck disable=SC2016
  podman exec commonair-seed-harness sh -c 'p=$(cat "$1" 2>/dev/null) && [ -n "$p" ] && kill -0 "$p" 2>/dev/null' \
    sh "$SEED_LIVE_PID" >/dev/null 2>&1
}

seed_live_start() {
  # shellcheck disable=SC2016
  podman exec -d --env=DEMO_SEED_PASSWORD commonair-seed-harness sh -c \
    'echo $$ >"$1"; exec bun harness/src/cli.ts seed live --channels "$2" >>"/reports/$3" 2>&1' \
    sh "$SEED_LIVE_PID" "$SEED_LIVE_CHANNELS" "$SEED_LIVE_LOG" >/dev/null ||
    die "seed live did not start in commonair-seed-harness" "see: journalctl --user -u commonair-seed-harness"
  sleep 5
  if seed_live_running; then
    info "seed live: $SEED_LIVE_CHANNELS seeded channels stream with chat until seed-mode close (log: $SEED_DATA_DIR/reports/$SEED_LIVE_LOG)"
  else
    warn "seed live exited at once; see $SEED_DATA_DIR/reports/$SEED_LIVE_LOG, then: selfhost.sh seed-mode live --confirm <host>"
  fi
}

# SIGTERM, then up to 30 s for its encoders to stop. Best effort: stopping the container ends it too.
seed_live_stop() {
  # shellcheck disable=SC2016
  podman exec commonair-seed-harness sh -c 'p=$(cat "$1" 2>/dev/null) || exit 0; kill -TERM "$p" 2>/dev/null; i=0; while kill -0 "$p" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done; rm -f "$1"' \
    sh "$SEED_LIVE_PID" >/dev/null 2>&1 || true
}

# Dumps the database once seed-$1 succeeded: as the owner, from one consistent snapshot while the
# stack keeps running (a template copy would need every connection closed).
seed_snapshot() {
  mkdir -p "$SEED_SNAP_DIR" || return 1
  podman exec --user postgres commonair-postgres pg_dump -Fc -U commonair -d commonair \
    >"$SEED_SNAP_DIR/after-$1.dump.tmp" || { rm -f "$SEED_SNAP_DIR/after-$1.dump.tmp"; return 1; }
  mv "$SEED_SNAP_DIR/after-$1.dump.tmp" "$SEED_SNAP_DIR/after-$1.dump"
}

# Puts the database back as it was after seed-$1, as reset-staging does with an empty one: the app
# units down (the idle seed harness stays up, so nothing it holds is lost), the database recreated
# from the dump, Valkey flushed (the failed unit's sessions, rate limits and queued jobs name rows
# the dump does not have), the stack back up.
seed_restore() {
  _stop=""
  for _u in $(sockets) $(services); do
    case " $RESET_KEEP commonair-seed-harness.service " in *" $_u "*) continue ;; esac
    _stop="$_stop $_u"
  done
  info "restoring the database as it was after seed-$1 ($SEED_SNAP_DIR/after-$1.dump)"
  # shellcheck disable=SC2086 # unit names have no spaces
  systemctl --user stop $_stop || die "could not stop the app units; the database was not touched" \
    "see: selfhost.sh status"
  reset_wait_data
  podman exec --user postgres commonair-postgres psql -X -q -v ON_ERROR_STOP=1 -U commonair -d postgres \
    -c 'DROP DATABASE IF EXISTS commonair WITH (FORCE)' -c 'CREATE DATABASE commonair OWNER commonair' ||
    die "dropping or recreating the database failed; the app units are stopped" \
      "see: journalctl --user -u commonair-postgres; re-running run --from is safe"
  podman exec -i --user postgres commonair-postgres pg_restore --exit-on-error -U commonair -d commonair \
    <"$SEED_SNAP_DIR/after-$1.dump" ||
    die "restoring the dump failed; the app units are stopped" \
      "re-running run --from is safe; or reset-staging and run again from the start"
  # shellcheck disable=SC2016 # expanded inside the container, where VALKEY_PASSWORD is set
  podman exec commonair-valkey sh -c 'export VALKEYCLI_AUTH="$VALKEY_PASSWORD"; valkey-cli FLUSHALL | grep -qx OK' ||
    die "flushing Valkey failed; the app units are stopped" "re-running run --from is safe"
  # shellcheck disable=SC2046
  systemctl --user start --no-block $(sockets) $(services)
  wait_healthy core || die "the instance did not become healthy after the restore" \
    "see: selfhost.sh status, and journalctl --user -u 'commonair-*'"
}

# `seed full` one unit at a time (--to), so the database is dumped between units and a failed run
# resumes at the failed unit (--from) instead of from a reset. The harness lists the units, so
# their order lives in one place.
cmd_seed_mode_run() {
  parse_seed_flags "$@"
  require_instance "seed-mode run"
  staging_guard "seed-mode run" "$SEED_CONFIRM"
  seed_require_open "seed-mode run"
  _units=$(seed_exec bun harness/src/cli.ts seed units) && [ -n "$_units" ] ||
    die "seed-mode run refused: the harness did not list its seed units" "see: journalctl --user -u commonair-seed-harness"
  _prev=""
  _todo=""
  _all=""
  for _u in $_units; do
    _all="$_all $_u"
    if [ -n "$_todo" ] || [ -z "$SEED_FROM" ] || [ "$_u" = "$SEED_FROM" ]; then
      _todo="$_todo $_u"
    else
      _prev=$_u
    fi
  done
  [ -n "$_todo" ] || die "seed-mode run refused: --from $SEED_FROM is not a seed unit. Nothing was changed." \
    "the units, in order:$_all"
  if [ -n "$_prev" ]; then
    [ -n "${DEMO_SEED_PASSWORD:-}" ] || die "seed-mode run refused: --from needs DEMO_SEED_PASSWORD. Nothing was changed." \
      "export the password the first run used (it printed it, or you gave it), then re-run"
    [ -f "$SEED_DATA_DIR/reports/seed-checkpoint-$_prev.json" ] && [ -f "$SEED_SNAP_DIR/after-$_prev.dump" ] ||
      die "seed-mode run refused: no checkpoint and snapshot after seed-$_prev. Nothing was changed." \
        "run --from a unit whose previous unit finished, or reset-staging and run again from the start"
  fi
  _dl=$(env_get DEADLINE "$SEED_STATE")
  _left=$(( (${_dl:-0} - $(date -u +%s)) / 60 ))
  info "running seed full --scale $SEED_SCALE --seed $SEED_N (${SEED_FROM:+from $SEED_FROM:}$_todo) in commonair-seed-harness ($_left minutes left before seed mode closes)"
  [ "$_left" -ge 120 ] || warn "less than 2 hours left: a medium seed may not finish before the timer closes seed mode"
  # seed live signs the accounts in after the run, so the password is made here when none is given.
  if [ -z "${DEMO_SEED_PASSWORD:-}" ]; then
    DEMO_SEED_PASSWORD=$(seed_random_hex)
    export DEMO_SEED_PASSWORD
    say "Password for every account: $DEMO_SEED_PASSWORD"
    say "(export DEMO_SEED_PASSWORD with it for seed-mode live and coverage, and for run --from)"
  fi
  if [ -n "$_prev" ]; then
    seed_restore "$_prev"
  else
    # A fresh run: an older run's dumps must not be restored over this one (the harness clears
    # its own checkpoints).
    rm -rf "$SEED_SNAP_DIR"
  fi
  _last=""
  for _u in $_todo; do _last=$_u; done
  for _u in $_todo; do
    _rc=0
    seed_exec bun harness/src/cli.ts seed full --confirm "$SEED_DB_TARGET" --scale "$SEED_SCALE" --seed "$SEED_N" \
      ${_prev:+--from "$_u"} --to "$_u" || _rc=$?
    if [ "$_rc" -ne 0 ]; then
      die "seed full exited with $_rc in seed-$_u" \
        "fix it, then resume there (it restores the database as it was after the unit before): sh $CURRENT_LINK/selfhost.sh seed-mode run --confirm $(env_get PUBLIC_HOSTNAME "$ENV_FILE") --scale $SEED_SCALE --seed $SEED_N --from $_u (with the same DEMO_SEED_PASSWORD)"
    fi
    # The last unit's dump would never be restored: --from always restores the one before it.
    if [ "$_u" != "$_last" ]; then
      seed_snapshot "$_u" || die "dumping the database after seed-$_u failed; the seed stopped there" \
        "see: journalctl --user -u commonair-postgres; disk space: df -h $SEED_DATA_DIR"
    fi
    _prev=$_u
  done
  say ""
  say "store report (accounts, channels, keys; no password): $SEED_DATA_DIR/reports/seed-store.json"
  seed_live_start
}

cmd_seed_mode_live() {
  parse_seed_flags "$@"
  require_instance "seed-mode live"
  staging_guard "seed-mode live" "$SEED_CONFIRM"
  seed_require_open "seed-mode live"
  [ -n "${DEMO_SEED_PASSWORD:-}" ] || die "seed-mode live refused: DEMO_SEED_PASSWORD is not set" \
    "export the password seed-mode run used (it printed it, or you gave it), then re-run"
  seed_live_stop
  seed_live_start
}

cmd_seed_mode_coverage() {
  parse_seed_flags "$@"
  require_instance "seed-mode coverage"
  staging_guard "seed-mode coverage" "$SEED_CONFIRM"
  seed_require_open "seed-mode coverage"
  [ -n "${DEMO_SEED_PASSWORD:-}" ] || die "seed-mode coverage refused: DEMO_SEED_PASSWORD is not set" \
    "export the password seed-mode run used (it printed it, or you gave it), then re-run"
  _rc=0
  seed_exec bun harness/src/cli.ts run seed-coverage || _rc=$?
  say ""
  say "coverage report: $SEED_DATA_DIR/reports/"
  [ "$_rc" -eq 0 ] || die "seed-coverage failed (exit $_rc); the report says which routes"
}

cmd_seed_mode_close() {
  parse_seed_flags "$@"
  require_instance "seed-mode close"
  if ! seed_lock; then
    say "another seed-mode open or close is running (pid $(seed_lock_holder); the timer's is $SEED_CLOSE_SERVICE). Nothing was changed."
    say "selfhost.sh status shows seed mode once it is done; run close again if it is still open"
    return 0
  fi
  _anything=no
  if seed_mode_open || seed_block_present || [ -f "$SYSTEMD_DIR/$SEED_TIMER" ]; then _anything=yes; fi
  for _f in $SEED_UNITS; do [ ! -f "$QUADLET_DIR/$_f" ] || _anything=yes; done
  for _u in $SEED_DROPIN_UNITS seed-harness; do [ ! -f "$QUADLET_DIR/commonair-$_u.container.d/$SEED_DROPIN" ] || _anything=yes; done
  if [ "$_anything" = no ]; then
    say "seed mode is not open: nothing to close"
    return 0
  fi
  _host=$(env_get PUBLIC_HOSTNAME "$ENV_FILE")
  info "closing seed mode on $_host"

  # 1. seed live first (its encoders end their broadcasts), then the timer and the seed-mode units.
  seed_live_stop
  systemctl --user disable --now "$SEED_TIMER" >/dev/null 2>&1 || true
  # shellcheck disable=SC2046 # unit names have no spaces
  systemctl --user stop $(seed_services) 2>/dev/null || true
  # The harness's env file, rendered at each of its starts, holds the instance's secrets.
  rm -f "$UNIT_ENV_DIR/commonair-seed-harness.env" "$UNIT_ENV_DIR/commonair-seed-harness.env.tmp."*

  # 2. The drop-ins, the block, and exactly the values the block replaced.
  seed_remove_dropins
  seed_env_rewrite ""
  if seed_mode_open; then
    for _k in $(seed_block_keys); do
      if grep -q "^PREV_$_k=" "$SEED_STATE"; then env_set "$_k" "$(env_get "PREV_$_k" "$SEED_STATE")"; fi
    done
  fi

  # 3. The units and the timer files gone, then what read the keys restarted.
  for _f in $SEED_UNITS; do rm -f "$QUADLET_DIR/$_f"; done
  rm -f "$SYSTEMD_DIR/$SEED_TIMER" "$SYSTEMD_DIR/$SEED_CLOSE_SERVICE"
  systemctl --user daemon-reload
  # shellcheck disable=SC2046
  systemctl --user restart $(seed_affected_units) || warn "a restart failed (selfhost.sh status)"
  wait_healthy core || warn "the instance is not healthy yet after closing seed mode (selfhost.sh status)"

  # 4. Last, so a close that stopped halfway runs again in full.
  rm -f "$SEED_STATE"
  say ""
  say "Seed mode is closed on $_host: test hooks, insecure settings, the mocks, Mailpit and the"
  say "harness are gone; federation, the Twitch import, payments, SMTP and the cost model are as before."
  say "Still on: giveaways, the watch gate, the surge guard and push. The seeded data stays."
}

seed_mode_status() {
  _closer=$(seed_lock_holder)
  if [ -n "$_closer" ] && seed_mode_open; then
    say "seed mode: being opened or closed (pid $_closer); see systemctl --user status $SEED_CLOSE_SERVICE"
    return 0
  fi
  if ! seed_mode_open; then
    if seed_block_present; then
      say "seed mode: a seed-mode block is in commonair.env without its state: run selfhost.sh seed-mode close"
    else
      say "seed mode: closed"
    fi
    return 0
  fi
  _dl=$(env_get DEADLINE "$SEED_STATE")
  _left=$(( (${_dl:-0} - $(date -u +%s)) / 60 ))
  if [ "$_left" -gt 0 ]; then
    say "seed mode: OPEN until $(env_get DEADLINE_UTC "$SEED_STATE") ($_left min left; selfhost.sh seed-mode close ends it now)"
  else
    say "seed mode: OPEN past its deadline $(env_get DEADLINE_UTC "$SEED_STATE") ($SEED_TIMER closes it; or selfhost.sh seed-mode close)"
  fi
  for _s in $(seed_services); do
    _state=$(systemctl --user show "$_s" --property=ActiveState --value 2>/dev/null || true)
    say "           ${_s%.service} ${_state:-?}"
  done
  if seed_live_running; then
    say "           seed live: running (live streams with chat; log $SEED_DATA_DIR/reports/$SEED_LIVE_LOG)"
  else
    say "           seed live: not running (selfhost.sh seed-mode live --confirm <host> starts it)"
  fi
}

cmd_seed_mode() {
  [ $# -gt 0 ] || die "seed-mode needs a subcommand: open, run, live, coverage or close" "see: selfhost.sh --help"
  _sub=$1
  shift
  case "$_sub" in
    open) cmd_seed_mode_open "$@" ;;
    run) cmd_seed_mode_run "$@" ;;
    live) cmd_seed_mode_live "$@" ;;
    coverage) cmd_seed_mode_coverage "$@" ;;
    close) cmd_seed_mode_close "$@" ;;
    -h | --help) usage ;;
    *) die "unknown seed-mode subcommand: $_sub" "see: selfhost.sh --help" ;;
  esac
}

main() {
  [ $# -gt 0 ] || {
    usage
    exit 2
  }
  _cmd=$1
  shift
  case "$_cmd" in
    install) cmd_install "$@" ;;
    upgrade) cmd_upgrade "$@" ;;
    backup) cmd_backup "$@" ;;
    status) cmd_status ;;
    reset-staging) cmd_reset_staging "$@" ;;
    seed-mode) cmd_seed_mode "$@" ;;
    -h | --help | help) usage ;;
    *) die "unknown command: $_cmd" "see: selfhost.sh --help" ;;
  esac
}

main "$@"
