// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The batch 7 compose overrides (harness/compose.{w3,n3,n4}.yaml), layered by `stack --harness
 * --w3` for the `w3` and `interact` shards: what each turns on, that the Twitch URLs reach the
 * harness mock's port, and that the `multi` replicas (which share the queues) get the same values.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { HARNESS_OVERRIDES, W3_OVERRIDES } from "../../../scripts/infra.ts";
import { REPLICAS } from "../../src/multi/replicas.ts";
import { TWITCH_MOCK_PORT } from "../../src/n3/index.ts";

type Env = Record<string, string>;
type Service = { environment?: Env };
type ComposeFile = { services?: Record<string, Service> };

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const load = (p: string) => Bun.YAML.parse(readFileSync(root(p), "utf8")) as ComposeFile;
const services = (p: string) => load(p).services ?? {};
const env = (p: string, svc: string): Env => services(p)[svc]?.environment ?? {};
const envExample = readFileSync(root(".env.example"), "utf8");
const exampleKeys = new Set([...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
const composeServices = new Set(Object.keys(services("compose.yaml")));

describe("W3_OVERRIDES", () => {
  test("the three batch 7 overrides exist and are not part of every harness stack", () => {
    expect([...W3_OVERRIDES]).toEqual([
      "harness/compose.w3.yaml",
      "harness/compose.n3.yaml",
      "harness/compose.n4.yaml",
    ]);
    for (const f of W3_OVERRIDES) {
      expect(existsSync(root(f)), f).toBe(true);
      expect(HARNESS_OVERRIDES as readonly string[]).not.toContain(f);
    }
  });

  test.each([...W3_OVERRIDES])("%s sets only known variables on known services", (f) => {
    for (const [name, svc] of Object.entries(services(f))) {
      const original = REPLICAS.find((r) => r.replica === name)?.service ?? name;
      expect(composeServices.has(original), `${f}: ${name}`).toBe(true);
      for (const key of Object.keys(svc.environment ?? {})) expect(exampleKeys.has(key), `${f}: ${key}`).toBe(true);
    }
  });

  // A replica that missed a flag would take the same jobs off the shared queues with it off.
  test.each([...W3_OVERRIDES])("%s gives every replica exactly its original's values", (f) => {
    const all = services(f);
    for (const spec of REPLICAS) {
      const original = all[spec.service]?.environment;
      const replica = all[spec.replica]?.environment;
      expect(replica, `${f}: ${spec.replica}`).toEqual(original);
    }
  });
});

describe("compose.w3.yaml", () => {
  test("giveaways on for every service that reads the flag (api, chat, worker)", () => {
    for (const svc of ["api", "chat", "worker"])
      expect(env("harness/compose.w3.yaml", svc).GIVEAWAYS_ENABLED).toBe("true");
  });
});

describe("compose.n3.yaml", () => {
  const f = "harness/compose.n3.yaml";
  test("the import on with fake Twitch credentials for the api and the worker", () => {
    for (const svc of ["api", "worker"]) {
      const e = env(f, svc);
      expect(e.TWITCH_IMPORT_ENABLED, svc).toBe("true");
      expect(e.OAUTH_TWITCH_CLIENT_ID, svc).toMatch(/^harness-/);
      expect(e.OAUTH_TWITCH_CLIENT_SECRET, svc).toMatch(/^harness-/);
      expect(e.OUTBOUND_ALLOW_PRIVATE_NETWORKS, svc).toBe("true");
    }
  });

  test("every Twitch URL is the harness mock on this machine, never Twitch", () => {
    for (const svc of ["api", "worker"]) {
      const e = env(f, svc);
      for (const key of ["TWITCH_API_BASE_URL", "TWITCH_AUTH_BASE_URL"] as const) {
        const u = new URL(e[key] ?? "");
        expect(u.protocol, `${svc} ${key}`).toBe("http:");
        expect(u.hostname, `${svc} ${key}`).toBe("host.containers.internal");
        expect(Number(u.port), `${svc} ${key}`).toBe(TWITCH_MOCK_PORT);
        expect(u.pathname.endsWith("/"), `${svc} ${key}: no trailing slash`).toBe(false);
      }
      expect(e.TWITCH_IMAGE_HOSTS?.split(","), svc).toEqual(["host.containers.internal"]);
      expect(JSON.stringify(e)).not.toMatch(/twitch\.tv|jtvnw\.net/);
    }
  });
});

describe("compose.n4.yaml", () => {
  test("federation on, private peers reachable, for the api and the worker", () => {
    for (const svc of ["api", "worker"]) {
      expect(env("harness/compose.n4.yaml", svc)).toEqual({
        FEDERATION_ENABLED: "true",
        OUTBOUND_ALLOW_PRIVATE_NETWORKS: "true",
      });
    }
  });
});
