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

DATA_DIR="$HOME/.local/share/commonair"
RELEASES_DIR="$DATA_DIR/releases"
PREVIOUS_LINK="$DATA_DIR/previous"
# Units bind-mount their config from %h/commonair/infra/…: a symlink to the current release, so
# a rollback is a symlink flip plus the previous release's units.
CURRENT_LINK="$HOME/commonair"
CONF_DIR="$HOME/.config/commonair"
ENV_FILE="$CONF_DIR/commonair.env"
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
  backup     Take a WAL-G base backup now and list the backups.
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

upgrade options: --version | --bundle, --sha256sums, --registry, --require-signature,
  --insecure-no-checksum.

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
have_aardvark() { [ -x "$SYSROOT/usr/lib/podman/aardvark-dns" ] || [ -x "$SYSROOT/usr/libexec/podman/aardvark-dns" ]; }
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
      "fix: log in as this user over SSH or with 'machinectl shell $(id -un)@' (su and sudo do not start one)"
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
    info "firewalld is running; open the public ports:"
    info "  sudo firewall-cmd --permanent --add-port={80,443,1935,6667,6697}/tcp --add-port={443,8189}/udp && sudo firewall-cmd --reload"
  elif have nft; then
    info "if an nftables ruleset filters input, allow tcp dports {80,443,1935,6667,6697} and udp dports {443,8189}"
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

images_of() {
  sed -n 's/^Image=//p' "$1"/quadlet/*.container | sort -u
}

tools_image() {
  sed -n 's/^Image=//p' "$1/quadlet/commonair-migrate.container" | head -n 1
}

pull_images() {
  for _img in $(images_of "$1"); do
    info "pulling $_img"
    podman pull --quiet "$_img" >/dev/null || die "could not pull $_img" \
      "fix: check the network and the registry (--registry for a mirror)"
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
}

# Podman secrets the units read, re-created from the env file every time (idempotent).
create_secrets() {
  _app=$(env_get POSTGRES_APP_PASSWORD "$ENV_FILE")
  _owner=$(env_get POSTGRES_PASSWORD "$ENV_FILE")
  _grafana=$(env_get GRAFANA_ADMIN_PASSWORD "$ENV_FILE")
  [ -n "$_app" ] && [ -n "$_owner" ] && [ -n "$_grafana" ] ||
    die "$ENV_FILE lacks POSTGRES_APP_PASSWORD, POSTGRES_PASSWORD or GRAFANA_ADMIN_PASSWORD"
  # printf is a shell builtin: the values never appear in a process list.
  printf 'postgres://commonair_app:%s@postgres:5432/commonair' "$_app" |
    podman secret create --replace commonair-database-url - >/dev/null
  printf 'postgres://commonair:%s@postgres:5432/commonair' "$_owner" |
    podman secret create --replace commonair-owner-database-url - >/dev/null
  printf '%s' "$_grafana" | podman secret create --replace commonair-grafana-admin-password - >/dev/null
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
  # Operator drop-ins (commonair-<unit>.container.d/, e.g. for a GPU) are directories and stay.
  for _f in "$QUADLET_DIR"/commonair*; do
    if [ -f "$_f" ] || [ -L "$_f" ]; then rm -f "$_f"; fi
  done
  cp "$_rel"/quadlet/* "$QUADLET_DIR/"
  # Units in ~/.config/systemd/user shadow Quadlet's generated ones, so a commonair-* unit the
  # release does not ship (an older release's, or one copied by hand for a manual install) goes.
  for _f in "$SYSTEMD_DIR"/commonair-*; do
    [ -e "$_f" ] || [ -L "$_f" ] || continue
    [ -d "$_f" ] && [ ! -L "$_f" ] && continue # a commonair-*.service.d drop-in
    _n=$(basename "$_f")
    [ -e "$_rel/systemd/$_n" ] && continue
    case "$_n" in *.timer) systemctl --user disable --now "$_n" >/dev/null 2>&1 || true ;; esac
    info "removing $_n (not part of this release)"
    rm -f "$_f"
  done
  cp "$_rel"/systemd/* "$SYSTEMD_DIR/"
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
  # shellcheck disable=SC2046 # unit names have no spaces
  systemctl --user stop $(all_units) 2>/dev/null || true
  # migrate and garage-init retry with a start limit; a release whose migrate kept failing
  # leaves them start-limit-hit, which would refuse this start (a rollback, or a re-run) for
  # up to an hour.
  systemctl --user reset-failed 'commonair-*' 2>/dev/null || true
  info "running migrations (commonair-migrate)"
  start_migrate || return 1
  info "starting the stack"
  # shellcheck disable=SC2046
  systemctl --user start --no-block $(services)
  systemctl --user enable --now commonair-backup.timer commonair-irc-cert.timer >/dev/null 2>&1 || true
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

cmd_upgrade() {
  parse_flags "$@"
  [ -L "$CURRENT_LINK" ] || die "no instance installed here" "fix: selfhost.sh install"
  _cur=$(readlink "$CURRENT_LINK")
  _curv=$(installed_version)
  resolve_repository_url
  if [ -z "$REGISTRY" ] && [ -f "$SELFHOST_CONF" ]; then REGISTRY=$(env_get REGISTRY "$SELFHOST_CONF"); fi
  check_podman
  check_systemd

  # 1. download and verify
  obtain_bundle
  [ "$BUNDLE_VERSION" != "$_curv" ] || die "version $_curv is already installed"
  extract_bundle
  apply_registry "$RELEASE_DIR" "$REGISTRY"
  # 2. pull every image by digest (nothing has changed yet if this fails)
  pull_images "$RELEASE_DIR"
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

cmd_backup() {
  [ -L "$CURRENT_LINK" ] || die "no instance installed here"
  info "running commonair-backup.service"
  systemctl --user start commonair-backup.service || die "the backup failed" "see: journalctl --user -u commonair-backup"
  podman exec --user postgres commonair-postgres \
    sh -c '. /usr/local/lib/commonair/walg-env.sh && wal-g backup-list'
}

cmd_status() {
  [ -L "$CURRENT_LINK" ] || die "no instance installed here"
  say "version:   $(installed_version) ($(readlink "$CURRENT_LINK"))"
  if [ -L "$PREVIOUS_LINK" ]; then say "previous:  $(env_get COMMONAIR_VERSION "$PREVIOUS_LINK/release.env")"; fi
  _tls=$(env_get TLS_MODE "$ENV_FILE")
  say "host:      $(env_get PUBLIC_HOSTNAME "$ENV_FILE")  tls: ${_tls:-acme}"
  if [ "${_tls:-acme}" = internal ]; then say "root CA:   $(caddy_root_path)"; fi
  _exp=$(cert_expiry)
  if [ -n "$_exp" ]; then say "cert:      expires $_exp"; fi
  say ""
  say "units:"
  for _u in $(all_units); do
    _state=$(systemctl --user show "$_u" --property=ActiveState --value 2>/dev/null || true)
    _sub=$(systemctl --user show "$_u" --property=SubState --value 2>/dev/null || true)
    _c=$(sed -n 's/^ContainerName=//p' "$QUADLET_DIR/${_u%.service}.container")
    _h=$(podman inspect --format '{{.State.Health.Status}}' "$_c" 2>/dev/null || true)
    printf '  %-34s %-10s %-10s %s\n' "${_u%.service}" "${_state:-?}" "${_sub:-?}" "${_h:--}"
  done
  say ""
  _last=$(systemctl --user show commonair-backup.service --property=ExecMainExitTimestamp --value 2>/dev/null || true)
  _res=$(systemctl --user show commonair-backup.service --property=Result --value 2>/dev/null || true)
  say "last backup: ${_last:-never} (${_res:-?})"
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
    backup) cmd_backup ;;
    status) cmd_status ;;
    -h | --help | help) usage ;;
    *) die "unknown command: $_cmd" "see: selfhost.sh --help" ;;
  esac
}

main "$@"
