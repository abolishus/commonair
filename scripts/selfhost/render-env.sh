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

(umask 077 && mkdir -p "$(dirname "$out")")
tmp="$out.tmp.$$"
trap 'rm -f "$tmp"' EXIT
(
  umask 077
  awk '
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
      if (k in exact) { print; next }
      for (p in prefix) if (index(k, p) == 1) { print; next }
    }
    END { if (bad) exit 2 }
  ' "$keys" "$src" >"$tmp"
) || fail "could not render $out"
chmod 600 "$tmp"
mv "$tmp" "$out"
