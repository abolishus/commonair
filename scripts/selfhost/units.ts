// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reading the Quadlet and systemd units in infra/ as data: the self-host bundle renders them
 * (render.ts), derives the config files they mount (bundle.ts), and the tests check their
 * restart, health and ordering rules from the same parse.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const QUADLET_DIR = "infra/quadlet";
export const SYSTEMD_DIR = "infra/systemd";

/** Files of a unit directory, by file name, sorted. */
export function readUnitDir(dir: string): Map<string, string> {
  const names = readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .sort();
  return new Map(names.map((n) => [n, readFileSync(join(dir, n), "utf8")]));
}

/** Every value of `key=` in a unit (any section), in order. */
export function unitValues(unit: string, key: string): string[] {
  const re = new RegExp(`^${key}=(.*)$`, "gm");
  return [...unit.matchAll(re)].map((m) => m[1] ?? "");
}

/** The lines of one `[section]` of a unit. */
export function unitSection(unit: string, section: string): string {
  const start = unit.indexOf(`[${section}]\n`);
  if (start === -1) return "";
  const rest = unit.slice(start + section.length + 3);
  const end = rest.search(/^\[[A-Za-z]+\]$/m);
  return end === -1 ? rest : rest.slice(0, end);
}

export const isOneShot = (unit: string) => /^Type=oneshot$/m.test(unit);

/** Host-side sources of `Volume=` bind mounts (`%h/...`); named `.volume` units are skipped. */
export function hostMountSources(unit: string): string[] {
  return unitValues(unit, "Volume")
    .map((v) => v.slice(0, v.indexOf(":")))
    .filter((src) => src.startsWith("%h/"));
}

/** Prefix of mounts that come from the release directory (`~/commonair` links to it). */
export const RELEASE_MOUNT_PREFIX = "%h/commonair/";

/**
 * Repository paths of every config file or directory a unit mounts from the release, e.g.
 * `infra/caddy/Caddyfile`. The bundle must ship each of them.
 */
export function releaseMounts(units: Iterable<string>): string[] {
  const paths = new Set<string>();
  for (const unit of units)
    for (const src of hostMountSources(unit))
      if (src.startsWith(RELEASE_MOUNT_PREFIX)) paths.add(src.slice(RELEASE_MOUNT_PREFIX.length));
  return [...paths].sort();
}

/**
 * Repository paths of the release files a unit's `ExecStartPre=` and `ExecStopPost=` lines run
 * or read on the host, e.g. `scripts/selfhost/render-env.sh` and the unit's key list. The bundle
 * ships each of them.
 */
export function releaseExecFiles(units: Iterable<string>): string[] {
  const paths = new Set<string>();
  for (const unit of units)
    for (const line of [...unitValues(unit, "ExecStartPre"), ...unitValues(unit, "ExecStopPost")])
      for (const word of line.split(/\s+/))
        if (word.startsWith(RELEASE_MOUNT_PREFIX)) paths.add(word.slice(RELEASE_MOUNT_PREFIX.length));
  return [...paths].sort();
}
