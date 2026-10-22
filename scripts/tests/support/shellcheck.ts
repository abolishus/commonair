// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pinned shellcheck (scripts/release/tools.ts, the one CI's lint-workflows installs), as a
 * local binary of exactly that version or else its pinned image. Any other shellcheck on PATH is
 * ignored: ubuntu-24.04 runners ship 0.9.0, whose findings differ (SC2015 on a line 0.11 accepts).
 */
import { basename } from "node:path";
import { TOOLS } from "../../release/tools.ts";

export const SHELLCHECK_IMAGE = `docker.io/koalaman/shellcheck:v${TOOLS.shellcheck.version}@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d`;

const local = (() => {
  const bin = Bun.which("shellcheck");
  if (!bin) return null;
  const v = Bun.spawnSync([bin, "--version"]).stdout.toString();
  return new RegExp(`^version: ${TOOLS.shellcheck.version.replaceAll(".", "\\.")}$`, "m").test(v) ? bin : null;
})();
const podman = Bun.which("podman");

/** False only where neither is available; CI must not skip, so callers fail there instead. */
export const shellcheckAvailable = local !== null || podman !== null;

/** Runs the pinned shellcheck on one POSIX sh script at style severity. */
export function shellcheck(script: string): { code: number; out: string } {
  if (!local && !podman)
    throw new Error(`shellcheck ${TOOLS.shellcheck.version} (or podman for its image) is required`);
  const name = basename(script);
  const r = local
    ? Bun.spawnSync([local, "--shell=sh", "--severity=style", script])
    : Bun.spawnSync([
        podman!,
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${script}:/mnt/${name}:ro,Z`,
        SHELLCHECK_IMAGE,
        "--shell=sh",
        "--severity=style",
        `/mnt/${name}`,
      ]);
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}
