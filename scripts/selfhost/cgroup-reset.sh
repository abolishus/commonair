#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# cgroup-reset.sh: the first ExecStopPost= of every container unit with RestartMode=direct (Quadlet
# appends its own `podman rm -v -f -i` after it; infra/tests/quadlet-order.test.ts and the e2e check that order).
#
# Leaves the unit's cgroup as systemd expects to find it at the next start: no sub-cgroups but
# its own .control, and no controllers enabled for children. Without this, a restart can fail for
# good with "Failed to spawn executor: Device or resource busy" (seen in the CI e2e after
# `podman kill`, on Debian 13 and Fedora 42, both systemd 257):
#
# - Quadlet runs `podman run --cgroups=split` with Delegate=yes. Podman creates sub-cgroups in
#   the unit's cgroup (runtime/, libpod-payload-<id>/) and enables cpu, memory and pids in its
#   cgroup.subtree_control.
# - systemd removes that cgroup ("prunes" it) when the unit goes inactive. With RestartMode=direct
#   the unit never does (service_enter_dead skips the *_BEFORE_AUTO_RESTART states), so the only
#   prune left is the one on a cgroup-empty event that arrives in the auto-restart state. When the
#   event is handled earlier, in stop-post before this command's own SIGCHLD, it is dropped and
#   nothing prunes the cgroup.
# - ExecStartPre= is then spawned into that cgroup, which still has a domain controller (memory)
#   enabled for children. cgroup v2 refuses a process there (no internal processes): EBUSY, on
#   every retry, until someone empties it.
#
# Upstream systemd also clears stale controllers in its prune (systemd PR 41304, after 257); that
# does not help here, where the prune never runs. This does it itself, from the unit's .control
# sub-cgroup, where systemd runs ExecStopPost= of a delegated unit. It never fails the unit: on a
# cgroup it cannot read, or a sub-cgroup that stays busy, it leaves things as they are.
set -u

# Tests pass a fake tree as $1; units pass nothing.
root=${1:-}

note() { printf 'cgroup-reset: %s\n' "$1" >&2; }

self=$(sed -n 's/^0:://p' "$root/proc/self/cgroup")
# Only a service of a user manager, from its .control: never a slice, the root or a system unit.
case $self in
  */user@*.service/*.service/.control) ;;
  *)
    note "not in a user service's .control cgroup ($self): nothing to reset"
    exit 0
    ;;
esac
unit=$root/sys/fs/cgroup${self%/.control}
[ -w "$unit/cgroup.subtree_control" ] || {
  note "cannot write $unit/cgroup.subtree_control"
  exit 0
}

# Podman's sub-cgroups (the glob skips .control): conmon's cleanup process may still be on its
# way out. Wait up to 10 s for them to empty.
busy=
populated() {
  for ev in "$unit"/*/cgroup.events; do
    [ -e "$ev" ] || continue
    busy=${ev%/cgroup.events}
    grep -qx 'populated 1' "$ev" && return 0
  done
  busy=
  return 1
}
i=0
while populated && [ "$i" -lt 100 ]; do
  sleep 0.1
  i=$((i + 1))
done

# A container still running here (ExecStop= failed; Quadlet's own `podman rm -f` comes after
# this) keeps its cgroup: disabling the controllers would still succeed and strip its limits.
# Leave it then: that restart may hit the old EBUSY loop (no worse than without this script).
if populated; then
  note "$busy is still busy after 10 s: leaving the cgroup as it is"
  exit 0
fi

# Deepest first.
find "$unit" -mindepth 1 -depth -type d ! -name .control -exec rmdir {} + 2>/dev/null

enabled=$(cat "$unit/cgroup.subtree_control")
[ -n "$enabled" ] || exit 0
# "cpu memory pids" -> "-cpu -memory -pids"
# The kernel refuses this only while a sub-cgroup has the controller enabled for its own children.
if ! printf '%s\n' "$enabled" | sed 's/[^ ][^ ]*/-&/g' >"$unit/cgroup.subtree_control" 2>/dev/null; then
  note "could not disable '$enabled' in $unit"
fi
exit 0
