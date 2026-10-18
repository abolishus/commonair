// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { rootsFor, serviceClosure } from "../containers/closure.ts";
import { HEALTH_PORTS, healthUrl, probe } from "../containers/healthcheck.ts";

const repo = mkdtempSync(join(tmpdir(), "closure-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function pkg(dir: string, manifest: Record<string, unknown>) {
  const p = join(repo, dir, "package.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(manifest));
}
pkg(".", { name: "root", workspaces: ["packages/*", "services/*", "apps/*", "infra"] });
pkg("packages/config", { name: "@x/config", dependencies: { zod: "1" } });
pkg("packages/db", { name: "@x/db", dependencies: { "@x/config": "workspace:*", postgres: "1" } });
pkg("packages/ui", { name: "@x/ui", dependencies: { "@x/config": "workspace:*" } });
pkg("packages/test-utils", { name: "@x/test-utils" });
pkg("services/api", {
  name: "@x/api",
  dependencies: { "@x/db": "workspace:*" },
  devDependencies: { "@x/test-utils": "workspace:*" },
});
pkg("services/broken", { name: "@x/broken", dependencies: { "@x/missing": "workspace:*" } });
pkg("apps/web", {
  name: "@x/web",
  dependencies: { "@x/ui": "workspace:*" },
  devDependencies: { "@x/test-utils": "workspace:*" },
});
pkg("infra", { name: "@x/infra", devDependencies: { "@x/ui": "workspace:*" } });

describe("workspace closure", () => {
  test("follows workspace dependencies transitively, not npm ones", () => {
    expect(serviceClosure("api", { root: repo })).toEqual(["packages/config", "packages/db", "services/api"]);
  });

  test("--dev adds the roots' dev workspaces only", () => {
    expect(serviceClosure("web", { root: repo, dev: true })).toEqual([
      "apps/web",
      "packages/config",
      "packages/test-utils",
      "packages/ui",
    ]);
  });

  test("tools image = db + infra", () => {
    expect(rootsFor("tools")).toEqual(["packages/db", "infra"]);
    expect(serviceClosure("tools", { root: repo })).toEqual(["infra", "packages/config", "packages/db"]);
  });

  test("unknown workspace deps and missing services fail loudly", () => {
    expect(() => serviceClosure("broken", { root: repo })).toThrow(/@x\/missing/);
    expect(() => serviceClosure("nope", { root: repo })).toThrow(/services\/nope/);
    expect(() => rootsFor("../etc")).toThrow(/invalid/);
  });

  test("the real repo: tools closure contains the migration sources", () => {
    const dirs = serviceClosure("tools", { root: new URL("../../", import.meta.url).pathname });
    expect(dirs).toContain("packages/db");
    expect(dirs).toContain("infra");
  });
});

describe("healthcheck", () => {
  test("ports match servicePorts defaults and honor env overrides", () => {
    expect(healthUrl("api", {})).toBe("http://127.0.0.1:3001/readyz");
    expect(healthUrl("irc", {})).toBe("http://127.0.0.1:6681/readyz");
    expect(healthUrl("api", { API_PORT: "4001", HEALTHCHECK_PATH: "/healthz" })).toBe("http://127.0.0.1:4001/healthz");
    expect(Object.keys(HEALTH_PORTS).sort()).toEqual(
      ["api", "chat", "irc", "media", "origin", "tracker", "web", "worker"].sort(),
    );
  });

  test("rejects unknown services, bad ports and paths", () => {
    expect(() => healthUrl("tools", {})).toThrow(/no health port/);
    expect(() => healthUrl("api", { API_PORT: "abc" })).toThrow(/API_PORT/);
    expect(() => healthUrl("api", { HEALTHCHECK_PATH: "readyz" })).toThrow(/HEALTHCHECK_PATH/);
  });

  test("probe: 2xx healthy, 503 and network errors unhealthy", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => new Response("x", { status: new URL(req.url).pathname === "/readyz" ? 200 : 503 }),
    });
    try {
      expect(await probe(`http://127.0.0.1:${server.port}/readyz`, 1000)).toBe(true);
      expect(await probe(`http://127.0.0.1:${server.port}/other`, 1000)).toBe(false);
    } finally {
      await server.stop(true);
    }
    expect(await probe("http://127.0.0.1:1/readyz", 500)).toBe(false);
  });

  test("probe times out on a hung endpoint", async () => {
    const hang: typeof fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as typeof fetch;
    expect(await probe("http://x/readyz", 50, hang)).toBe(false);
  });
});
