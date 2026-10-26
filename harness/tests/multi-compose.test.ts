// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The replicas in harness/compose.multi-instance.yaml are spelled out (podman-compose's
 * `extends` would also bind the original's host port), so this keeps each one identical to its
 * original as compose.yaml plus every other harness override merge it, apart from the host port.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { HARNESS_OVERRIDES } from "../../scripts/infra.ts";
import { REPLICAS } from "../src/multi/replicas.ts";

type Service = Record<string, unknown>;
type ComposeFile = { services?: Record<string, Service> };

const MULTI_FILE = "harness/compose.multi-instance.yaml";
const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const load = (p: string) => Bun.YAML.parse(readFileSync(root(p), "utf8")) as ComposeFile;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const mountTarget = (v: unknown) => (typeof v === "string" ? v.split(":")[1] : undefined);

/** podman-compose's merge of a later file into an earlier one (rec_merge_one). */
function merge(target: Service, source: Service): Service {
  const out: Service = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const prev = out[key];
    if (isObject(prev) && isObject(value)) out[key] = merge(prev, value);
    else if (Array.isArray(prev) && Array.isArray(value)) {
      if (key === "volumes") {
        const targets = new Set(value.map(mountTarget).filter(Boolean));
        out[key] = [...prev.filter((v) => !targets.has(mountTarget(v))), ...value];
      } else out[key] = [...prev, ...value];
    } else out[key] = value;
  }
  return out;
}

const others = (HARNESS_OVERRIDES as readonly string[]).filter((f) => f !== MULTI_FILE);
const originals: Record<string, Service> = {};
for (const file of ["compose.yaml", ...others]) {
  for (const [name, svc] of Object.entries(load(file).services ?? {}))
    originals[name] = originals[name] ? merge(originals[name], svc) : svc;
}
const multi = load(MULTI_FILE).services ?? {};

describe("compose.multi-instance.yaml", () => {
  test("declares exactly the replicas the scenario expects", () => {
    expect(Object.keys(multi).sort()).toEqual(REPLICAS.map((r) => r.replica).sort());
  });

  for (const spec of REPLICAS) {
    describe(`${spec.replica}`, () => {
      const replica = multi[spec.replica] ?? {};
      const original = originals[spec.service] ?? {};

      test("is behind the multi profile, so nothing starts unless asked", () => {
        expect(replica.profiles).toEqual(["multi"]);
      });

      test("publishes only its own host port, from its *_2_PORT variable", () => {
        const containerPort = String((original.ports as string[])[0])
          .split(":")
          .at(-1);
        expect(replica.ports).toEqual([
          `\${BIND_ADDRESS:-127.0.0.1}:\${${spec.portVar}:-${spec.defaultPort}}:${containerPort}`,
        ]);
      });

      test("runs the original's image without building it again", () => {
        expect(replica.build).toBeUndefined();
        expect(replica.image).toBe(original.image);
      });

      for (const key of ["environment", "volumes", "env_file", "depends_on", "healthcheck", "restart"]) {
        test(`matches the merged original's ${key}`, () => {
          // Mount order does not matter; every other value must be equal as is.
          const norm = (v: unknown) =>
            key === "volumes" && Array.isArray(v) ? [...v].map(String).sort((x, y) => x.localeCompare(y)) : v;
          expect(norm(replica[key])).toEqual(norm(original[key]));
        });
      }

      test("sets nothing else the original lacks", () => {
        const extra = Object.keys(replica).filter((k) => !(k in original) && k !== "profiles");
        expect(extra).toEqual([]);
      });
    });
  }

  test("replica host ports do not collide with any port compose publishes", () => {
    const all = readFileSync(root("compose.yaml"), "utf8");
    const used = new Set([...all.matchAll(/_PORT:-(\d+)\}/g)].map((m) => Number(m[1])));
    for (const r of REPLICAS) expect(used.has(r.defaultPort)).toBe(false);
  });

  test("ingest services and the tracker stay single (ADR 0032)", () => {
    for (const single of ["media", "mediamtx", "tracker", "irc", "web"])
      expect(Object.keys(multi).some((n) => n.startsWith(`${single}-`))).toBe(false);
  });
});
