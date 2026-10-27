#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# start.sh [--render-only]
#
# coturn's entrypoint (compose and commonair-coturn.container): renders the configuration from
# the static turnserver.conf next to it plus the environment, then runs turnserver on it. Nothing
# secret is in the image or in git; the rendered file lives only in the container (/tmp, 0600).
#
# The environment (commonair.env, through the unit's key list):
#   TURN_PORT            listening port, UDP (default 3478; the Quadlet unit pins 3478)
#   PUBLIC_HOSTNAME      the realm (default localhost)
#   TURN_EXTERNAL_IP     the public address coturn advertises (optional, one address)
#   P2P_TURN_URLS        non-empty turns the TURN relay on (selfhost.sh --turn-relay writes it);
#                        empty, the default, leaves a STUN-only server that refuses allocations
#   TURN_SHARED_SECRET   with the relay on: the TURN REST secret the API signs credentials with
#   TURN_RELAY_PORT_MIN, TURN_RELAY_PORT_MAX
#                        with the relay on: the UDP relay range (default 49160-49199)
#
# Every value is checked before it reaches the file, so no value can add a line (an option) of
# its own. Errors go to stderr and stop the start: the rendered configuration logs nothing.
#
# --render-only writes the file and exits (tests). COTURN_BASE_CONF and COTURN_CONF move the
# input and output (tests); they are not operator settings.
set -eu

base=${COTURN_BASE_CONF:-/etc/coturn/commonair/turnserver.conf}
conf=${COTURN_CONF:-/tmp/turnserver.conf}

fail() {
  printf 'coturn: %s\n' "$1" >&2
  exit 1
}

is_port() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

port=${TURN_PORT:-3478}
is_port "$port" || fail "TURN_PORT must be a port from 1024 to 65535, not '$port'"

# grep matches line by line, so the character check (case) comes first: a newline fails it.
realm=${PUBLIC_HOSTNAME:-localhost}
case "$realm" in *[!A-Za-z0-9.-]*) fail "PUBLIC_HOSTNAME is not a hostname: '$realm'" ;; esac
printf '%s' "$realm" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$' ||
  fail "PUBLIC_HOSTNAME is not a hostname: '$realm'"

external=${TURN_EXTERNAL_IP:-}
if [ -n "$external" ]; then
  case "$external" in *[!0-9A-Fa-f.:]*) fail "TURN_EXTERNAL_IP must be one IPv4 or IPv6 address, not '$external'" ;; esac
  printf '%s' "$external" | grep -Eq '^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*)$' ||
    fail "TURN_EXTERNAL_IP must be one IPv4 or IPv6 address, not '$external'"
fi

# Commas and blanks alone are an empty list, as the API parses it.
relay=off
case "${P2P_TURN_URLS:-}" in *[!,[:space:]]*) relay=on ;; esac

[ -r "$base" ] || fail "cannot read $base"
umask 077
tmp="$conf.tmp.$$"
trap 'rm -f "$tmp"' EXIT
{
  cat "$base"
  printf '\n# --- rendered by start.sh from the environment ---\n'
  printf 'listening-port=%s\n' "$port"
  printf 'realm=%s\n' "$realm"
  # The public address itself stays allowed: when both viewers are relayed, each one's peer is
  # the other's relay port on this address. The relay is UDP only, and this host's other public
  # UDP ports (443, 8189) are open to everyone anyway.
  # coturn substitutes it only for relayed addresses of the same family (turn_set_xor_relayed_addr
  # in ns_turn_server.c), so an IPv4 value never replaces an IPv6 allocation's address, and on a
  # host whose public address is on an interface it names that same address.
  if [ -n "$external" ]; then printf 'external-ip=%s\n' "$external"; fi
  if [ "$relay" = on ]; then
    secret=${TURN_SHARED_SECRET:-}
    [ ${#secret} -ge 32 ] || fail "P2P_TURN_URLS is set: the relay needs TURN_SHARED_SECRET (32 characters or more)"
    case "$secret" in *[!A-Za-z0-9._~+/=-]*) fail "TURN_SHARED_SECRET may hold only letters, digits and . _ ~ + / = -" ;; esac
    min=${TURN_RELAY_PORT_MIN:-49160}
    max=${TURN_RELAY_PORT_MAX:-49199}
    is_port "$min" || fail "TURN_RELAY_PORT_MIN must be a port from 1024 to 65535, not '$min'"
    is_port "$max" || fail "TURN_RELAY_PORT_MAX must be a port from 1024 to 65535, not '$max'"
    [ "$min" -le "$max" ] || fail "TURN_RELAY_PORT_MIN ($min) is above TURN_RELAY_PORT_MAX ($max)"
    if [ "$port" -ge "$min" ] && [ "$port" -le "$max" ]; then fail "TURN_PORT ($port) is inside the relay range"; fi
    printf '# TURN relay: on (P2P_TURN_URLS is set)\n'
    # TURN REST credentials only (username "<expiry>:<id>", HMAC-SHA1 password; the API mints them).
    printf 'use-auth-secret\n'
    printf 'static-auth-secret=%s\n' "$secret"
    printf 'min-port=%s\nmax-port=%s\n' "$min" "$max"
    # Allocations per session. coturn counts the quota on the username without its "<expiry>:"
    # prefix (get_real_username in userdb.c, with use-auth-secret), so every refresh of one
    # session shares one counter. The player keeps at most a handful of peer connections, each
    # needing one allocation. Five sessions can still fill the default 40-port range
    # (docs/self-hosting/p2p.md, "Limits").
    printf 'user-quota=8\n'
    # Allocations in all: 8 per viewer for 50 viewers whose peers need a relay at the same time.
    # Each holds a relay port too, so the default 40-port range is the tighter limit.
    printf 'total-quota=400\n'
    # Bytes per second per session: 1.25 MB/s (10 Mbit/s), above any rendition's bitrate, so a
    # relayed peer never starves, while a session cannot take the whole uplink.
    printf 'max-bps=1250000\n'
  else
    printf '# TURN relay: off (P2P_TURN_URLS is empty): STUN binding requests only, no allocations\n'
    printf 'stun-only\n'
  fi
} >"$tmp"
mv "$tmp" "$conf"
trap - EXIT

[ "${1:-}" = --render-only ] && exit 0
# The secret is in the file; the server process does not keep it in its environment.
exec env -u TURN_SHARED_SECRET turnserver -c "$conf"
