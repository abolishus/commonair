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
  status     Show the installed version, every unit's state and health, TLS, backups, disk use.
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

upgrade options: --version | --bundle, --sha256sums, --registry, --require-signature,
  --insecure-no-checksum. The object store stays as installed.

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
  Exit status 0 on success, 1 on any failure. A successful --objects run records its time in
  ~/.local/state/commonair/object-backup, which status shows.

A fork's releases: set COMMONAIR_REPOSITORY_URL=https://… for the first install; later
upgrades use the repository recorded in the installed release.

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

# Public ports: Caddy 80/443 (+443/udp HTTP/3), RTMP 1935, IRC 6667/6697, WebRTC ICE 8189/udp.
check_ports() {
  have ss || { warn "ss not found; skipping the free-port check"; return 0; }
  _busy=""
  _tcp=$(ss -Hltn 2>/dev/null | awk '{print $4}' | sed 's/.*://')
  _udp=$(ss -Hlun 2>/dev/null | awk '{print $4}' | sed 's/.*://')
  for _p in 80 443 1935 6667 6697; do
    if printf '%s\n' "$_tcp" | grep -qx "$_p"; then _busy="$_busy $_p/tcp"; fi
  done
  for _p in 443 8189; do
    if printf '%s\n' "$_udp" | grep -qx "$_p"; then _busy="$_busy $_p/udp"; fi
  done
  if [ -n "$_busy" ]; then
    die "ports already in use:$_busy" \
      "fix: stop whatever listens there (sudo ss -ltnup shows it), e.g. a web server on 80/443"
  fi
}

firewall_hints() {
  if have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    info "firewalld is running; open the public ports (IPv4 and IPv6):"
    info "  sudo firewall-cmd --permanent --add-port={80,443,1935,6667,6697}/tcp --add-port={443,8189}/udp && sudo firewall-cmd --reload"
  elif have nft; then
    info "if an nftables ruleset filters input, allow tcp dports {80,443,1935,6667,6697} and udp dports {443,8189}, for IPv4 and IPv6 (an inet table covers both)"
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

host_checks() {
  check_distro
  check_podman
  check_systemd
  check_rootless
  # Our own containers hold these ports on a re-install or upgrade.
  if ! instance_exists; then check_ports; fi
  firewall_hints
  ipv6_hint
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
        DEBIAN_FRONTEND=noninteractive apt-get install -y -q podman catatonit uidmap passt aardvark-dns nftables dbus-user-session curl ca-certificates
        ;;
      fedora)
        info "installing podman and its helpers (dnf)"
        dnf install -y -q podman catatonit passt aardvark-dns nftables curl
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
  # shellcheck disable=SC2046,SC2016 # validated flags without spaces; $HOME/$@ expand in the inner sh
  runuser -u "$SERVICE_USER" -- env HOME="$_home" XDG_RUNTIME_DIR="$_rt" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$_rt/bus" sh -c 'cd "$HOME" && exec sh "$@"' sh \
    "$_stage/selfhost.sh" install $(user_args "$_stage") || _rc=$?
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
  for _u in "$_rel"/quadlet/*.container; do
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
  for _u in "$1"/quadlet/*.container; do
    if unit_in_mode "$(basename "$_u")"; then sed -n 's/^Image=//p' "$_u"; fi
  done | sort -u
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
  for _img in $(images_of "$1"); do
    info "pulling $_img"
    _try=1
    _wait=5
    until _err=$(podman pull --quiet "$_img" 2>&1 >/dev/null); do
      printf '%s\n' "$_err" >&2
      if [ "$_try" -ge "$PULL_ATTEMPTS" ] || ! pull_transient "$_err"; then
        die "could not pull $_img" "fix: check the network and the registry (--registry for a mirror)"
      fi
      warn "pulling $_img failed (attempt $_try of $PULL_ATTEMPTS), retrying in ${_wait}s"
      sleep "$_wait"
      _try=$((_try + 1))
      _wait=$((_wait * 3))
    done
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
  # The app-role URL; the services get it as a podman secret as well (create_secrets).
  _app=$(env_get POSTGRES_APP_PASSWORD "$ENV_FILE")
  env_set DATABASE_URL "postgres://commonair_app:$_app@postgres:5432/commonair"
  valkey_env
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
  # VALKEY_PASSWORD for this upgrade.
  valkey_env
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

# Whether a unit file of the release belongs to this instance: Garage's only in Garage mode.
unit_in_mode() {
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
      "docs/self-hosting/backups.md, section 'Objects in Garage') and install a new instance against it."
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
      "docs/self-hosting/backups.md, section 'Objects in Garage') and install a new instance against that store."
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

# Podman secrets the units read, re-created from the env file every time (idempotent).
create_secrets() {
  _app=$(env_get POSTGRES_APP_PASSWORD "$ENV_FILE")
  _owner=$(env_get POSTGRES_PASSWORD "$ENV_FILE")
  _grafana=$(env_get GRAFANA_ADMIN_PASSWORD "$ENV_FILE")
  if [ -z "$_app" ] || [ -z "$_owner" ] || [ -z "$_grafana" ]; then
    die "$ENV_FILE lacks POSTGRES_APP_PASSWORD, POSTGRES_PASSWORD or GRAFANA_ADMIN_PASSWORD"
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
  info "podman secrets updated"
}

# Host files the units bind-mount outside the release directory (derived from Volume= lines):
# hash lists, the moderation model and the IRC certificate directory.
host_mount_sources() {
  sed -n 's|^Volume=%h/\([^:]*\):.*|\1|p' "$1"/quadlet/*.container | grep -v '^commonair/' | sort -u
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
      *.onnx) fetch_model "$_rel" "$_path" ;;
      *) mkdir -p "$_path" ;;
    esac
  done
}

# The classifier weights, verified against the pinned sha256 by fetch-model in the tools image.
fetch_model() {
  _dir=$(dirname "$2")
  _file=$(basename "$2")
  mkdir -p "$_dir"
  if [ -n "$MODEL_SRC" ] && [ ! -e "$2" ]; then
    [ -f "$MODEL_SRC" ] || die "no such model file: $MODEL_SRC"
    cp "$MODEL_SRC" "$2"
  fi
  info "checking the moderation model (downloads it if missing)"
  podman run --rm --user 0:0 --entrypoint bun \
    -v "$1/tools:/tools:ro,Z" -v "$_dir:/models:z" -w /tools \
    "$(tools_image "$1")" /tools/fetch-model.js --out "/models/$_file" >/dev/null ||
    die "the moderation model is missing or does not match its pinned sha256" \
      "fix: re-run with network access, or pass --model <path> with a verified copy"
}

install_units() {
  _rel=$1
  mkdir -p "$QUADLET_DIR" "$SYSTEMD_DIR"
  # A container unit this install drops (rc.2's commonair-garage-init, now storage-init) is
  # stopped while its generated service still exists: after the daemon-reload below systemd
  # could no longer stop it by its unit file, and a one-shot would stay "active" forever.
  for _f in "$QUADLET_DIR"/commonair-*.container; do
    [ -f "$_f" ] || continue
    _n=$(basename "$_f")
    if [ ! -e "$_rel/quadlet/$_n" ] || ! unit_in_mode "$_n"; then
      info "stopping ${_n%.container} (not part of this install)"
      systemctl --user stop "${_n%.container}.service" >/dev/null 2>&1 || true
    fi
  done
  # Operator drop-ins (commonair-<unit>.container.d/, e.g. for a GPU) are directories and stay.
  for _f in "$QUADLET_DIR"/commonair*; do
    if [ -f "$_f" ] || [ -L "$_f" ]; then rm -f "$_f"; fi
  done
  # With an external object store, Garage and its volumes are not installed at all.
  for _f in "$_rel"/quadlet/*; do
    if unit_in_mode "$(basename "$_f")"; then cp "$_f" "$QUADLET_DIR/"; fi
  done
  # Units in ~/.config/systemd/user shadow Quadlet's generated ones, so a commonair-* unit the
  # release does not ship (an older release's, or one copied by hand for a manual install) goes.
  for _f in "$SYSTEMD_DIR"/commonair-*; do
    [ -e "$_f" ] || [ -L "$_f" ] || continue
    [ -d "$_f" ] && [ ! -L "$_f" ] && continue # a commonair-*.service.d drop-in
    _n=$(basename "$_f")
    [ -e "$_rel/systemd/$_n" ] && continue
    case "$_n" in *.timer | *.socket) systemctl --user disable --now "$_n" >/dev/null 2>&1 || true ;; esac
    info "removing $_n (not part of this release)"
    rm -f "$_f"
  done
  cp "$_rel"/systemd/* "$SYSTEMD_DIR/"
  # Each unit's env file is rendered from commonair.env at every start of the unit (ExecStartPre=
  # with the release's render-env.sh and key list). Drop the old ones, so no copy of a secret
  # stays behind for a unit this release no longer has, or under a key it no longer passes.
  rm -rf "$UNIT_ENV_DIR"
  systemctl --user daemon-reload
  info "units installed from $_rel"
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
  # shellcheck disable=SC2046
  systemctl --user enable --now $(sockets) commonair-backup.timer commonair-irc-cert.timer >/dev/null 2>&1 || true
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
  say "  - Backups: commonair-backup.timer runs daily; selfhost.sh backup runs one now."
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
  while [ $# -gt 0 ]; do
    case "$1" in
      --version | --bundle | --sha256sums | --domain | --email | --tls | --registry | --public-ip | --model)
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
  for _f in "$BUNDLE" "$SUMS_FILE" "$MODEL_SRC"; do
    case "$_f" in *[[:space:]]*) die "paths with spaces are not supported: $_f" ;; esac
  done
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
    root_prepare
    run_as_service_user
  fi
  resolve_repository_url
  if instance_exists && [ "$REINSTALL" != yes ]; then
    die "an instance is already installed (version $(installed_version))" \
      "re-run with --reinstall to reinstall it (secrets are kept), or use: selfhost.sh upgrade"
  fi
  if [ -z "$DOMAIN" ]; then DOMAIN=$(env_get PUBLIC_HOSTNAME "$ENV_FILE"); fi
  [ -n "$DOMAIN" ] || die "--domain is required on the first install"
  if [ -z "$EMAIL" ] && [ -z "$(env_get CONTACT_EMAIL "$ENV_FILE")" ]; then
    die "--email is required on the first install (ACME notices and the instance contacts)"
  fi
  if [ -z "$TLS" ]; then TLS=$(env_get TLS_MODE "$ENV_FILE"); fi
  TLS=${TLS:-acme}
  if [ -z "$REGISTRY" ] && [ -f "$SELFHOST_CONF" ]; then REGISTRY=$(env_get REGISTRY "$SELFHOST_CONF"); fi
  resolve_storage

  host_checks
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
  apply_registry "$RELEASE_DIR" "$REGISTRY"
  pull_images "$RELEASE_DIR"
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

rollback() {
  _prev=$1
  warn "rolling back to $(env_get COMMONAIR_VERSION "$_prev/release.env")"
  ln -sfn "$_prev" "$CURRENT_LINK"
  install_units "$_prev"
  if bring_up; then
    die "upgrade failed; rolled back to $(installed_version), which is healthy" \
      "the failed release stays in $RELEASES_DIR for inspection" \
      "last resort if the schema change broke it: restore the pre-upgrade backup (selfhost.sh backup lists it)"
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
  _cur=$(readlink "$CURRENT_LINK")
  _curv=$(installed_version)
  [ "$S3_FLAGS" = no ] || die "the object store is chosen at install: --s3-* flags apply to install --reinstall, not upgrade"
  read_storage_mode "$ENV_FILE"
  resolve_repository_url
  if [ -z "$REGISTRY" ] && [ -f "$SELFHOST_CONF" ]; then REGISTRY=$(env_get REGISTRY "$SELFHOST_CONF"); fi
  check_podman

  # 1. download and verify
  obtain_bundle
  [ "$BUNDLE_VERSION" != "$_curv" ] || die "version $_curv is already installed"
  extract_bundle
  apply_registry "$RELEASE_DIR" "$REGISTRY"
  # 2. pull every image by digest (nothing has changed yet if this fails)
  pull_images "$RELEASE_DIR"
  network_preflight
  # 3. base backup of the current database
  info "taking a base backup before the upgrade"
  systemctl --user start commonair-backup.service ||
    die "the pre-upgrade backup failed; nothing was changed" "see: journalctl --user -u commonair-backup"
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

parse_backup_flags() {
  BACKUP_DATABASE=no
  BACKUP_OBJECTS=no
  RESTORE_OBJECTS=no
  OBJ_BWLIMIT=""
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
      -h | --help) usage && exit 0 ;;
      *) die "unknown backup option: $1" "see: selfhost.sh --help" ;;
    esac
  done
  if [ "$RESTORE_OBJECTS" = yes ] && { [ "$BACKUP_DATABASE" = yes ] || [ "$BACKUP_OBJECTS" = yes ]; }; then
    die "--restore-objects runs on its own, not with --database or --objects"
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
rclone_run() {
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
    # --checksum compares hash and size, which S3 listings carry, instead of a HEAD per object for
    # its modification time; an object without a hash both sides share is compared by size.
    exec rclone "$1" "$2" "$3" --checksum --stats=1m --stats-one-line --stats-log-level=NOTICE \
      ${OBJ_BWLIMIT:+"--bwlimit=$OBJ_BWLIMIT"}
  )
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

backup_objects() {
  require_rclone
  object_remote
  object_source
  _first=yes
  [ ! -f "$OBJECT_STATE" ] || _first=no
  # Garage: one read-only key for both buckets. External: a read-only key if the operator made
  # one (BACKUP_OBJECTS_SOURCE_*), else each bucket's own instance key (sync never writes there).
  if [ "$STORAGE_MODE" != external ]; then garage_backup_key; fi
  for _role in media evidence; do
    if [ "$_role" = media ]; then _bucket=$OBJ_MEDIA; else _bucket=$OBJ_EVIDENCE; fi
    if [ "$STORAGE_MODE" = external ]; then
      if [ -n "$(env_get BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID "$ENV_FILE")" ]; then
        use_source_keys BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY
      elif [ "$_role" = media ]; then
        use_source_keys S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
      else
        use_source_keys S3_EVIDENCE_ACCESS_KEY_ID S3_EVIDENCE_SECRET_ACCESS_KEY
      fi
    fi
    info "copying $_bucket to $OBJ_DST_ENDPOINT, $(offsite_path "$_role" | sed 's/^caoffsite://')"
    rclone_run sync "cainstance:$_bucket" "$(offsite_path "$_role")" ||
      die "copying $_bucket offsite failed" \
        "see the rclone lines above; selfhost.sh status still shows the last successful run"
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
      die "restoring $_bucket failed" "see the rclone lines above; re-running it is safe (it copies only what is missing or different)"
  done
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
  say ""
  say "units:"
  for _u in $(all_units); do
    _state=$(systemctl --user show "$_u" --property=ActiveState --value 2>/dev/null || true)
    _sub=$(systemctl --user show "$_u" --property=SubState --value 2>/dev/null || true)
    _c=$(sed -n 's/^ContainerName=//p' "$QUADLET_DIR/${_u%.service}.container")
    _h=$(podman inspect --format '{{.State.Health.Status}}' "$_c" 2>/dev/null || true)
    printf '  %-34s %-10s %-10s %s\n' "${_u%.service}" "${_state:-?}" "${_sub:-?}" "${_h:--}"
  done
  for _u in $(sockets); do
    _state=$(systemctl --user show "$_u" --property=ActiveState --value 2>/dev/null || true)
    _sub=$(systemctl --user show "$_u" --property=SubState --value 2>/dev/null || true)
    printf '  %-34s %-10s %-10s %s\n' "$_u" "${_state:-?}" "${_sub:-?}" "-"
  done
  say ""
  _last=$(systemctl --user show commonair-backup.service --property=ExecMainExitTimestamp --value 2>/dev/null || true)
  _res=$(systemctl --user show commonair-backup.service --property=Result --value 2>/dev/null || true)
  say "last backup: ${_last:-never} (${_res:-?})"
  say "last object backup: $(object_backup_summary)"
  say ""
  say "volumes:"
  for _v in $(podman volume ls --quiet --filter name=commonair- 2>/dev/null); do
    _mp=$(podman volume inspect "$_v" --format '{{.Mountpoint}}' 2>/dev/null || true)
    _sz=$(podman unshare du -sh "$_mp" 2>/dev/null | awk '{print $1}' || true)
    printf '  %-28s %s\n' "$_v" "${_sz:-?}"
  done
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
    -h | --help | help) usage ;;
    *) die "unknown command: $_cmd" "see: selfhost.sh --help" ;;
  esac
}

main "$@"
