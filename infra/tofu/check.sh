#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Static checks for the OpenTofu definitions: fmt, validate in every root and module, and the
# mocked-provider tests. Needs no token and touches no account (the tests use mock_provider).
# Without tofu it skips with a message, unless REQUIRE_TOFU=1 (CI), where it fails.
set -euo pipefail

want="1.13.1"
here="$(cd "$(dirname "$0")" && pwd)"

if ! command -v tofu >/dev/null 2>&1; then
  if [ "${REQUIRE_TOFU:-0}" = "1" ]; then
    echo "tofu: not installed and REQUIRE_TOFU=1" >&2
    exit 1
  fi
  echo "tofu: not installed, skipping infra/tofu checks (install OpenTofu $want: infra/tofu/README.md)"
  exit 0
fi

have="$(tofu version -json | sed -n 's/.*"terraform_version": *"\([^"]*\)".*/\1/p')"
if [ "$have" != "$want" ]; then
  echo "tofu: found $have, the definitions pin $want (infra/tofu/README.md)" >&2
  exit 1
fi

# Roots read the state passphrase into their encryption block; validate needs a value, never
# a real one.
export TF_VAR_state_passphrase="validate-only-not-a-secret"
export TF_IN_AUTOMATION=1

echo "tofu fmt -check"
tofu fmt -check -recursive "$here"

for dir in "$here"/digitalocean/modules/* "$here"/digitalocean/envs/*; do
  [ -d "$dir" ] || continue
  rel="${dir#"$here"/}"
  echo "tofu validate: $rel"
  # -lockfile=readonly: the committed .terraform.lock.hcl must already hold the right hashes.
  tofu -chdir="$dir" init -backend=false -input=false -lockfile=readonly >/dev/null
  tofu -chdir="$dir" validate -no-color
  if [ -d "$dir/tests" ]; then
    echo "tofu test: $rel"
    tofu -chdir="$dir" test -no-color
  fi
done
