// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs the pinned Caddy image (the one commonair-caddy.container uses) against
 * infra/caddy/Caddyfile: `caddy validate` must accept it in every TLS mode, with the optional
 * values unset or empty (as the env file writes them), and `caddy adapt` must pick the issuer
 * the mode asks for. Needs podman.
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

interface Policy {
  subjects?: string[];
  issuers?: { module: string; email?: string; ca?: string }[];
}
function policies(env: Record<string, string>): Policy[] {
  const { code, out } = caddy("adapt", env);
  expect(code, out).toBe(0);
  const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as {
    apps: { tls: { automation: { policies: Policy[] } } };
  };
  return json.apps.tls.automation.policies;
}
/** The policy that applies to `host`: its own, or the catch-all Caddy merges identical ones into. */
function sitePolicy(env: Record<string, string>, host: string): Policy | undefined {
  const all = policies(env);
  return all.find((p) => p.subjects?.includes(host)) ?? all.find((p) => !p.subjects);
}

// Every case the env file or compose can produce: unset (compose passes only PUBLIC_HOSTNAME),
// empty (init-env writes ACME_EMAIL= and ACME_CA=), and set.
const CASES: [string, Record<string, string>][] = [
  ["nothing set (compose defaults)", {}],
  ["hostname only", { PUBLIC_HOSTNAME: "stream.example.org" }],
  ["acme, empty optionals", { PUBLIC_HOSTNAME: "stream.example.org", TLS_MODE: "acme", ACME_EMAIL: "", ACME_CA: "" }],
  ["empty TLS_MODE", { PUBLIC_HOSTNAME: "stream.example.org", TLS_MODE: "", ACME_EMAIL: "", ACME_CA: "" }],
  [
    "acme with email and CA",
    {
      PUBLIC_HOSTNAME: "stream.example.org",
      TLS_MODE: "acme",
      ACME_EMAIL: "ops@example.org",
      ACME_CA: "https://acme-staging-v02.api.letsencrypt.org/directory",
    },
  ],
  ["internal", { PUBLIC_HOSTNAME: "selfhost.test", TLS_MODE: "internal", ACME_EMAIL: "", ACME_CA: "" }],
];

describe("caddy validate (pinned image)", () => {
  test.each(CASES)(
    "%s: valid",
    (_, env) => {
      const { code, out } = caddy("validate", env);
      expect(code, out).toBe(0);
      expect(out).toContain("Valid configuration");
    },
    TIMEOUT,
  );

  test(
    "an unknown TLS_MODE refuses to load",
    () => {
      const { code, out } = caddy("validate", { PUBLIC_HOSTNAME: "stream.example.org", TLS_MODE: "selfsigned" });
      expect(code).not.toBe(0);
      expect(out).toContain("tls-selfsigned");
    },
    TIMEOUT,
  );
});

describe("caddy adapt: the mode picks the issuer", () => {
  test(
    "acme by default, no email, Let's Encrypt",
    () => {
      const p = sitePolicy(
        { PUBLIC_HOSTNAME: "stream.example.org", ACME_EMAIL: "", ACME_CA: "" },
        "stream.example.org",
      );
      expect(p?.issuers).toEqual([{ module: "acme" }]);
    },
    TIMEOUT,
  );

  test(
    "acme with ACME_EMAIL and ACME_CA",
    () => {
      const ca = "https://acme-staging-v02.api.letsencrypt.org/directory";
      const p = sitePolicy(
        { PUBLIC_HOSTNAME: "stream.example.org", TLS_MODE: "acme", ACME_EMAIL: "ops@example.org", ACME_CA: ca },
        "stream.example.org",
      );
      expect(p?.issuers).toEqual([{ module: "acme", email: "ops@example.org", ca }]);
    },
    TIMEOUT,
  );

  test(
    "internal uses Caddy's own CA for the host",
    () => {
      const p = sitePolicy({ PUBLIC_HOSTNAME: "selfhost.test", TLS_MODE: "internal", ACME_EMAIL: "" }, "selfhost.test");
      expect(p?.issuers).toEqual([{ module: "internal" }]);
    },
    TIMEOUT,
  );
});
