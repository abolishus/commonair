#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# render-env.sh <keys-file> <source-env> <out-env>
#
# Writes the lines of <source-env> (the operator's commonair.env) whose key <keys-file> lists to
# <out-env>, mode 0600, so a container receives only the variables it needs. Every unit with an
# env file runs this as ExecStartPre=, so an edit to commonair.env reaches a unit on its next
# start or restart. Lines are copied verbatim (leading whitespace trimmed, as podman does): values
# may hold '=', quotes and spaces.
#
# <keys-file>: one key per line; `PREFIX_*` selects every key that starts with PREFIX_. Blank
# lines and `#` comments are ignored. The key lists live in infra/selfhost/env/ and are generated
# by scripts/selfhost/unit-env.ts.
#
# Fails closed: the old <out-env> is removed first, so after any error the unit has no env file
# and does not start (podman refuses a missing --env-file), never with a stale one.
#
# One exception to verbatim: with Garage on this host (S3_MODE unset, empty or garage), a listed
# S3_ENDPOINT, S3_REGION or S3_FORCE_PATH_STYLE is always Garage's in-network value, the one
# selfhost.sh's storage_env writes (GARAGE_S3_ENDPOINT). Units up to 0.1.0-rc.2 pinned these
# themselves, so the env file kept init-env's development values (S3_ENDPOINT=localhost:3900),
# and an upgrade run by the rc.2 script never rewrites them: media then failed its readiness
# with ECONNREFUSED. An external store's values (S3_MODE=external) are copied as they are.
set -eu

fail() {
  printf 'render-env: %s\n' "$1" >&2
  exit 1
}

[ $# -eq 3 ] || fail "usage: render-env.sh <keys-file> <source-env> <out-env>"
keys=$1
src=$2
out=$3

rm -f "$out"
{ [ -f "$keys" ] && [ -r "$keys" ]; } || fail "cannot read the key list $keys"
{ [ -f "$src" ] && [ -r "$src" ]; } || fail "cannot read $src"
grep -Eq '^[A-Za-z_]' "$keys" || fail "the key list $keys is empty"
# An env file without a single assignment is not the operator's file (truncated, wrong path).
grep -Eq '^[A-Za-z_][A-Za-z0-9_]*=' "$src" || fail "$src has no KEY=value lines"

# The last assignment wins, as in podman's --env-file.
s3_mode=$(sed -n 's/^[[:blank:]]*S3_MODE=//p' "$src" | tail -n 1 | tr -d '\r')
case "$s3_mode" in
  "" | garage) garage=1 ;;
  *) garage=0 ;;
esac

(umask 077 && mkdir -p "$(dirname "$out")")
tmp="$out.tmp.$$"
trap 'rm -f "$tmp"' EXIT
(
  umask 077
  awk -v garage="$garage" '
    BEGIN {
      pinned["S3_ENDPOINT"] = "http://garage:3900"
      pinned["S3_REGION"] = "garage"
      pinned["S3_FORCE_PATH_STYLE"] = "true"
    }
    function emit(k) {
      if (garage && (k in pinned)) {
        if (!(k in done)) print k "=" pinned[k]
        done[k] = 1
        return
      }
      print
    }
    NR == FNR {
      sub(/\r$/, "")
      if ($0 ~ /^[ \t]*(#|$)/) next
      if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*\*$/) { prefix[substr($0, 1, length($0) - 1)] = 1; next }
      if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*$/) { exact[$0] = 1; next }
      printf "render-env: bad key list entry: %s\n", $0 > "/dev/stderr"
      bad = 1
      exit 2
    }
    # Podman reads an indented assignment as an assignment (it trims leading whitespace), so an
    # operator who indents a line must not silently lose that variable here.
    /^[ \t]*[A-Za-z_][A-Za-z0-9_]*=/ {
      sub(/^[ \t]+/, "")
      k = substr($0, 1, index($0, "=") - 1)
      if (k in exact) { emit(k); next }
      for (p in prefix) if (index(k, p) == 1) { emit(k); next }
    }
    END {
      if (bad) exit 2
      # Listed but missing from the file: Garage still has its one address.
      if (garage) for (k in pinned) if ((k in exact) && !(k in done)) print k "=" pinned[k]
    }
  ' "$keys" "$src" >"$tmp"
) || fail "could not render $out"
chmod 600 "$tmp"
mv "$tmp" "$out"
