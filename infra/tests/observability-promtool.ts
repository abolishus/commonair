// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs a shell script with the pinned Prometheus image's promtool (the image commonair-prometheus
 * uses), with infra/prometheus at /etc/prometheus and infra/ at /infra, as the unit runs it.
 * Without podman it falls back to a `promtool` binary on the PATH, with the paths rewritten.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { podmanAvailable } from "../../packages/db/tests/external-owner-tls.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
export const PROM_DIR = join(ROOT, "infra/prometheus");
export const PROM_IMAGE =
  /^Image=(.*)$/m.exec(readFileSync(join(ROOT, "infra/quadlet/commonair-prometheus.container"), "utf8"))?.[1] ?? "";

export const HAVE_PODMAN = podmanAvailable();
export const HAVE_PROMTOOL = !HAVE_PODMAN && Bun.which("promtool") !== null;
export const CAN_RUN_PROMTOOL = HAVE_PODMAN || HAVE_PROMTOOL;

/** Fails in CI when neither is there; elsewhere warns that `what` is skipped. */
export function requirePromtool(file: string): void {
  if (CAN_RUN_PROMTOOL) return;
  if (process.env.CI) throw new Error(`${file} needs podman (or promtool), and CI must run it`);
  console.warn(`\n*** ${file}: promtool checks SKIPPED (no podman, no promtool) ***\n`);
}

export function runPromtool(script: string, timeoutMs = 900_000): { code: number; out: string } {
  const r = HAVE_PODMAN
    ? Bun.spawnSync(
        [
          "podman",
          "run",
          "--rm",
          "--network",
          "none",
          "-v",
          `${PROM_DIR}:/etc/prometheus:ro,Z`,
          "-v",
          `${join(ROOT, "infra")}:/infra:ro,Z`,
          "--entrypoint",
          "/bin/sh",
          PROM_IMAGE,
          "-c",
          script,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: timeoutMs },
      )
    : Bun.spawnSync(
        ["sh", "-c", script.replaceAll("/etc/prometheus", PROM_DIR).replaceAll("/infra/", join(ROOT, "infra/"))],
        { stdout: "pipe", stderr: "pipe", timeout: timeoutMs },
      );
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}
