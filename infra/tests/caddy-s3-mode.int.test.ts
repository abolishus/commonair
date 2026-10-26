// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pinned Caddy image (commonair-caddy.container) against infra/caddy/Caddyfile in every
 * S3_MODE: valid unset, empty, garage and external; the adapted routes dial Garage only in
 * Garage mode; an unknown mode refuses to load. Needs podman.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const CADDYFILE = new URL("../caddy/Caddyfile", import.meta.url).pathname;
const IMAGE = /^Image=(.*)$/m.exec(
  readFileSync(new URL("../quadlet/commonair-caddy.container", import.meta.url), "utf8"),
)![1]!;
const TIMEOUT = 180_000;

function caddy(command: "validate" | "adapt", env: Record<string, string>): { code: number; out: string } {
  const args = ["run", "--rm", "--network", "none"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(
    "-v",
    `${CADDYFILE}:/etc/caddy/Caddyfile:ro,Z`,
    IMAGE,
    "caddy",
    command,
    "--config",
    "/etc/caddy/Caddyfile",
  );
  if (command === "adapt") args.push("--adapter", "caddyfile");
  const r = Bun.spawnSync(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

const HOST = { PUBLIC_HOSTNAME: "stream.example.org" };

describe("caddy and S3_MODE (pinned image)", () => {
  test.each([
    ["unset", HOST, 2],
    ["empty", { ...HOST, S3_MODE: "" }, 2],
    ["garage", { ...HOST, S3_MODE: "garage" }, 2],
    ["external", { ...HOST, S3_MODE: "external" }, 0],
    [
      "external, systemd sockets, internal TLS",
      { ...HOST, S3_MODE: "external", CADDY_LISTEN: "systemd", TLS_MODE: "internal" },
      0,
    ],
  ] as [string, Record<string, string>, number][])(
    "%s: valid, and the adapted routes dial Garage only in Garage mode",
    (_, env, dials) => {
      const v = caddy("validate", env);
      expect(v.code, v.out).toBe(0);
      const a = caddy("adapt", env);
      expect(a.code, a.out).toBe(0);
      expect(a.out.match(/"dial":\s*"garage:3900"/g) ?? []).toHaveLength(dials);
    },
    TIMEOUT,
  );

  test(
    "an unknown S3_MODE refuses to load",
    () => {
      const { code, out } = caddy("validate", { ...HOST, S3_MODE: "minio" });
      expect(code).not.toBe(0);
      expect(out).toContain("s3-minio");
    },
    TIMEOUT,
  );
});
