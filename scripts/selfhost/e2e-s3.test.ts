// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pure parts of scripts/selfhost/e2e-s3.ts: what it asks selfhost.sh for, how it prepares
 * the second store, and how it reads `status`. The checks themselves run in the self-host e2e.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  E2E_KEYS,
  E2E_STORE,
  GARAGE_IMAGE,
  checkExternalStore,
  corsXml,
  externalInstallEnv,
  externalInstallFlags,
  externalStoreSetup,
  garageToml,
  presignScript,
  setupScript,
  statusProblems,
} from "./e2e-s3.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

describe("the second store", () => {
  test("is the instance's pinned Garage image", () => {
    expect(GARAGE_IMAGE).toMatch(/^docker\.io\/dxflrs\/garage:v[\d.]+@sha256:[0-9a-f]{64}$/);
  });

  test("keys in Garage's format, fresh and distinct", () => {
    expect(E2E_KEYS.S3_ACCESS_KEY_ID).toMatch(/^GK[0-9a-f]{24}$/);
    expect(E2E_KEYS.S3_EVIDENCE_ACCESS_KEY_ID).toMatch(/^GK[0-9a-f]{24}$/);
    expect(E2E_KEYS.S3_SECRET_ACCESS_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(E2E_KEYS.S3_ACCESS_KEY_ID).not.toBe(E2E_KEYS.S3_EVIDENCE_ACCESS_KEY_ID);
    expect(externalInstallEnv()).toEqual(E2E_KEYS);
  });

  test("garage.toml signs for the region the install passes, secrets left to the environment", () => {
    expect(garageToml()).toContain(`s3_region = "${E2E_STORE.region}"`);
    expect(garageToml()).not.toMatch(/rpc_secret|admin_token/);
  });

  test("CORS allows the instance's origin to PUT", () => {
    const xml = corsXml("https://selfhost.test");
    expect(xml).toContain("<AllowedOrigin>https://selfhost.test</AllowedOrigin>");
    expect(xml).toContain("<AllowedMethod>PUT</AllowedMethod>");
  });

  test("setup: buckets, each key on its own buckets only, CORS on media; no secret in the script", () => {
    const s = setupScript("https://selfhost.test");
    for (const b of Object.values(E2E_STORE.buckets)) expect(s).toContain(`bucket create ${b}`);
    expect(s).toContain(`bucket allow --read --write --owner ${E2E_STORE.buckets.media} --key e2e-main`);
    expect(s).toContain(`bucket allow --read --write --owner ${E2E_STORE.buckets.evidence} --key e2e-evidence`);
    expect(s).not.toContain(`${E2E_STORE.buckets.evidence} --key e2e-main`);
    expect(s).toContain(`${E2E_STORE.publicEndpoint}/${E2E_STORE.buckets.media}?cors`);
    expect(s).toContain(`-p ${E2E_STORE.s3Port}:3900`);
    // Outside the instance: rootful, never on the commonair network.
    expect(s).not.toContain("--network");
    for (const v of Object.values(E2E_KEYS)) expect(s).not.toContain(v);
  });

  test("setup hands the keys and Garage's secrets over the environment, and checks the result", () => {
    const calls: { script: string; env?: Record<string, string> }[] = [];
    const seen: [boolean, string][] = [];
    externalStoreSetup(
      (script, opts) => {
        calls.push({ script, env: opts?.env });
        return script.includes("store-ready") ? "store-ready\n" : "403";
      },
      (ok, what) => seen.push([ok, what]),
    );
    expect(calls[0]!.env).toMatchObject(E2E_KEYS);
    expect(Object.keys(calls[0]!.env!)).toEqual(expect.arrayContaining(["GARAGE_RPC_SECRET", "GARAGE_ADMIN_TOKEN"]));
    expect(seen.every(([ok]) => ok)).toBe(true);
  });
});

describe("the install it asks for", () => {
  test("the flags pass selfhost.sh's own validation (it gets as far as asking for the keys)", () => {
    const home = mkdtempSync(join(tmpdir(), "commonair-e2e-s3-"));
    const r = Bun.spawnSync(
      [
        "sh",
        join(ROOT, "scripts/selfhost.sh"),
        "install",
        "--domain",
        "selfhost.test",
        "--email",
        "ops@selfhost.test",
        ...externalInstallFlags().split(" "),
      ],
      { env: { PATH: process.env.PATH ?? "", HOME: home }, stdin: "ignore" },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("an external object store needs its keys; missing: S3_ACCESS_KEY_ID");
  });

  test("two endpoints: the containers' and the browser's", () => {
    const f = externalInstallFlags();
    expect(f).toContain(`--s3-endpoint ${E2E_STORE.endpoint}`);
    expect(f).toContain(`--s3-public-endpoint ${E2E_STORE.publicEndpoint}`);
    expect(f).toContain("--s3-allow-http");
    for (const v of Object.values(E2E_KEYS)) expect(f).not.toContain(v);
  });
});

describe("reading the result", () => {
  const OK = [
    "storage:   external S3 at http://host.containers.internal:3910 (region garage, path style true)",
    "  media     e2e-media                    ok",
    "  exports   e2e-exports                  ok",
    "  backups   e2e-backups                  ok",
    "  evidence  e2e-evidence                 ok",
  ].join("\n");

  test("status with every bucket ok has no problem", () => {
    expect(statusProblems(OK)).toEqual([]);
  });

  test("a failed bucket, a warning, a missing line or a key in the output are problems", () => {
    expect(
      statusProblems(OK.replace("e2e-exports                  ok", "e2e-exports                  FAILED: x")),
    ).toContain("exports (e2e-exports) not ok");
    expect(statusProblems(`${OK}\n  WARNING: S3_ACCESS_KEY_ID can list`)).toContain("a failure or warning");
    expect(statusProblems(OK.replace(/^storage:.*$/m, ""))).toContain("no 'storage: external S3' line");
    expect(statusProblems(`${OK}\n${E2E_KEYS.S3_SECRET_ACCESS_KEY}`)).toContain("a key in the output");
  });

  test("the presign script signs an exact-length PNG upload into incoming/", () => {
    const s = presignScript("r1", "presign", 1234);
    expect(s).toContain('"uploadKey":"incoming/e2e/r1.png"');
    expect(s).toContain('contentType: "image/png", contentLength: c.size');
    expect(s).toContain('"size":1234');
  });

  test("checkExternalStore fails loudly when Garage is still installed", () => {
    const seen: [boolean, string][] = [];
    expect(() =>
      checkExternalStore(
        (script) => {
          if (script.startsWith("ls ")) return "commonair-garage.container\ncommonair-storage-init.container\n";
          throw new Error("stop");
        },
        (ok, what) => seen.push([ok, what]),
      ),
    ).toThrow("stop");
    expect(seen[0]).toEqual([false, "no Garage unit or volume is installed"]);
  });
});
