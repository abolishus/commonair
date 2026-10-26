// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The units after R0-b: the S3 endpoint, region and path style come from commonair.env through
 * each unit's key list instead of `Environment=` lines, so Garage mode and an external store go
 * through one path, and commonair-storage-init replaces commonair-garage-init. In Garage mode
 * every container still sees the values it saw before (selfhost.sh writes Garage's into the env
 * file), which these tests check against a snapshot of the moved lines.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { APP_UNITS, STATIC_UNITS, appSchemaKeys, keysPath, parseKeysFile, RENDER_SCRIPT } from "./unit-env.ts";
import { QUADLET_DIR, readUnitDir, unitValues } from "./units.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const units = readUnitDir(join(ROOT, QUADLET_DIR));
const unit = (u: string) => units.get(`commonair-${u}.container`) ?? "";
const listed = (u: string) => parseKeysFile(readFileSync(join(ROOT, keysPath(u)), "utf8"));
const MOVED_KEYS = ["S3_ENDPOINT", "S3_REGION", "S3_FORCE_PATH_STYLE", "WALG_S3_ENDPOINT"];

/** The `Environment=` lines each unit had before R0-b and no longer has (the snapshot). */
const MOVED: Record<string, string[]> = Object.fromEntries([
  ...["api", "chat", "media", "origin", "tracker", "web", "worker"].map((u) => [
    u,
    ["S3_ENDPOINT=http://garage:3900", "S3_REGION=garage", "S3_FORCE_PATH_STYLE=true"],
  ]),
  ["postgres", ["WALG_S3_ENDPOINT=http://garage:3900", "S3_REGION=garage"]],
]);
/** Units that required commonair-garage-init and now require commonair-storage-init. */
const STORAGE_USERS = ["api", "chat", "media", "origin", "tracker", "worker"];
/**
 * commonair-irc.container belongs to R0-a in this wave: its S3 lines and its garage-init
 * dependency are a contract request, applied when the two branches merge.
 */
const PENDING = new Set(["irc"]);

/** The env file selfhost.sh writes in Garage mode, as far as storage goes. */
const GARAGE_ENV: Record<string, string> = {
  S3_ENDPOINT: "http://garage:3900",
  S3_REGION: "garage",
  S3_FORCE_PATH_STYLE: "true",
  S3_PUBLIC_ENDPOINT: "https://stream.example.org",
  S3_BUCKET_MEDIA: "commonair-media",
  S3_BUCKET_EXPORTS: "commonair-exports",
  S3_BUCKET_BACKUPS: "commonair-backups",
  S3_BUCKET_EVIDENCE: "commonair-evidence",
  S3_ACCESS_KEY_ID: "GK000000000000000000000000",
  S3_SECRET_ACCESS_KEY: "0".repeat(64),
};

function renderFor(u: string, env: Record<string, string>): Record<string, string> {
  const d = mkdtempSync(join(tmpdir(), "commonair-storage-units-"));
  const src = join(d, "commonair.env");
  writeFileSync(
    src,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
  const out = join(d, "out.env");
  const r = Bun.spawnSync(["sh", join(ROOT, RENDER_SCRIPT), join(ROOT, keysPath(u)), src, out]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return Object.fromEntries(
    readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

describe("the S3 settings moved from the units to the env file", () => {
  const containers = [...units.keys()].filter((f) => f.endsWith(".container")).map((f) => f.slice(10, -10));

  test.each(containers.filter((u) => !PENDING.has(u)))("%s pins no S3 endpoint, region or path style", (u) => {
    const pinned = unitValues(unit(u), "Environment").filter((e) => MOVED_KEYS.includes(e.slice(0, e.indexOf("="))));
    expect(pinned).toEqual([]);
  });

  test.each(Object.entries(MOVED))("%s: each moved line it reads now comes through its key list", (u, lines) => {
    const reads = APP_UNITS.includes(u as (typeof APP_UNITS)[number])
      ? appSchemaKeys(u as (typeof APP_UNITS)[number])
      : STATIC_UNITS[u]!.keys;
    const rendered = renderFor(u, GARAGE_ENV);
    // walg-env.sh derives WALG_S3_ENDPOINT's part from S3_ENDPOINT (tested below). A unit that
    // never read a value (chat, tracker, web) had a dead line, and now gets nothing at all.
    const pairs = lines
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const)
      .filter(([k]) => k !== "WALG_S3_ENDPOINT");
    const want = Object.fromEntries(pairs.map(([k, v]) => [k, reads.includes(k) ? v : undefined]));
    const got = Object.fromEntries(pairs.map(([k]) => [k, rendered[k]]));
    expect(got).toEqual(want);
  });

  test("the services that read storageEnv list all three: api, media, origin, worker", () => {
    for (const u of ["api", "media", "origin", "worker"])
      for (const k of ["S3_ENDPOINT", "S3_REGION", "S3_FORCE_PATH_STYLE"]) expect(listed(u), `${u} ${k}`).toContain(k);
  });

  test("postgres gets the store's endpoint, region and path style for WAL-G", () => {
    for (const k of ["S3_ENDPOINT", "S3_REGION", "S3_FORCE_PATH_STYLE"]) expect(listed("postgres")).toContain(k);
  });
});

describe("WAL-G finds the store through the env file (infra/postgres/walg-env.sh)", () => {
  function walg(env: Record<string, string>): Record<string, string> {
    const script = `. ${join(ROOT, "infra/postgres/walg-env.sh")}; for k in AWS_ENDPOINT AWS_REGION AWS_S3_FORCE_PATH_STYLE WALG_S3_PREFIX AWS_ACCESS_KEY_ID; do eval "printf '%s=%s\\n' $k \\"\\$$k\\""; done`;
    const r = Bun.spawnSync(["sh", "-c", script], { env: { PATH: process.env.PATH ?? "", ...env } });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    return Object.fromEntries(
      r.stdout
        .toString()
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  }

  test("Garage mode: what the unit's WALG_S3_ENDPOINT and S3_REGION lines gave before", () => {
    const before = walg({ ...GARAGE_ENV, WALG_S3_ENDPOINT: "http://garage:3900" });
    const after = walg(GARAGE_ENV);
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      AWS_ENDPOINT: "http://garage:3900",
      AWS_REGION: "garage",
      AWS_S3_FORCE_PATH_STYLE: "true",
      WALG_S3_PREFIX: "s3://commonair-backups/wal",
      AWS_ACCESS_KEY_ID: GARAGE_ENV.S3_ACCESS_KEY_ID,
    });
  });

  test("an external store: its endpoint, region, path style and backups bucket", () => {
    expect(
      walg({
        ...GARAGE_ENV,
        S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
        S3_REGION: "nyc3",
        S3_FORCE_PATH_STYLE: "false",
        S3_BUCKET_BACKUPS: "ca-backups",
      }),
    ).toMatchObject({
      AWS_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
      AWS_REGION: "nyc3",
      AWS_S3_FORCE_PATH_STYLE: "false",
      WALG_S3_PREFIX: "s3://ca-backups/wal",
    });
  });

  test("the operator's AWS_* and WALG_S3_PREFIX still win (ADR 0025: backups in another store)", () => {
    expect(
      walg({
        ...GARAGE_ENV,
        S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
        S3_FORCE_PATH_STYLE: "false",
        AWS_ENDPOINT: "https://ams3.digitaloceanspaces.com",
        AWS_REGION: "ams3",
        AWS_ACCESS_KEY_ID: "DOBACKUPKEY",
        WALG_S3_PREFIX: "s3://offsite/wal",
      }),
    ).toEqual({
      AWS_ENDPOINT: "https://ams3.digitaloceanspaces.com",
      AWS_REGION: "ams3",
      // The default it always had for an operator's endpoint, not the instance's own path style.
      AWS_S3_FORCE_PATH_STYLE: "true",
      WALG_S3_PREFIX: "s3://offsite/wal",
      AWS_ACCESS_KEY_ID: "DOBACKUPKEY",
    });
  });

  test("compose's WALG_S3_ENDPOINT still wins over S3_ENDPOINT", () => {
    expect(walg({ S3_ENDPOINT: "http://localhost:3900", WALG_S3_ENDPOINT: "http://garage:3900" }).AWS_ENDPOINT).toBe(
      "http://garage:3900",
    );
  });
});

describe("commonair-storage-init replaces commonair-garage-init", () => {
  test("the one-shot runs storage-init.ts, after Garage when Garage is installed", () => {
    const s = unit("storage-init");
    expect(units.has("commonair-garage-init.container")).toBe(false);
    expect(unitValues(s, "Exec")).toEqual(["bun infra/garage/storage-init.ts"]);
    expect(unitValues(s, "Type")).toEqual(["oneshot"]);
    expect(unitValues(s, "RemainAfterExit")).toEqual(["yes"]);
    expect(unitValues(s, "Wants")).toEqual(["commonair-garage.service"]);
    expect(unitValues(s, "After")).toEqual(["commonair-garage.service"]);
    expect(unitValues(s, "ContainerName")).toEqual(["commonair-storage-init"]);
  });

  test.each(STORAGE_USERS)("%s requires storage-init (and nothing named garage-init)", (u) => {
    expect(unitValues(unit(u), "Requires")).toContain("commonair-storage-init.service");
    expect(unitValues(unit(u), "After")).toContain("commonair-storage-init.service");
    expect(unit(u)).not.toContain("garage-init");
  });

  test("no unit but the pending one names garage-init", () => {
    const naming = [...units].filter(([, t]) => t.includes("garage-init")).map(([n]) => n.slice(10, -10));
    expect(naming.filter((u) => !PENDING.has(u))).toEqual([]);
  });

  test("its key list: Garage's bootstrap, the external store's settings and keys, no other secret", () => {
    const keys = listed("storage-init");
    for (const k of [
      "S3_MODE",
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_FORCE_PATH_STYLE",
      "S3_ACCESS_KEY_ID",
      "S3_EVIDENCE_ACCESS_KEY_ID",
      "GARAGE_ADMIN_TOKEN",
      "AWS_ENDPOINT",
      "WALG_S3_PREFIX",
    ])
      expect(keys).toContain(k);
    expect(keys.filter((k) => /PASSWORD|AUTH_SECRET|DATABASE_URL|AWS_SECRET|AWS_ACCESS/.test(k))).toEqual([]);
  });

  test("every variable storage-init.ts and bootstrap.ts read is in that list or set by the unit", () => {
    const src = ["infra/garage/storage-init.ts", "infra/garage/bootstrap.ts"]
      .map((f) => readFileSync(join(ROOT, f), "utf8"))
      .join("\n");
    const vars = new Set([
      ...[...src.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!),
      ...[...src.matchAll(/(?:need|positive)\("([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]!),
    ]);
    const set = new Set(unitValues(unit("storage-init"), "Environment").map((e) => e.slice(0, e.indexOf("="))));
    expect([...vars].filter((v) => !set.has(v) && !listed("storage-init").includes(v)).sort()).toEqual([]);
  });

  test("Caddy gets S3_MODE (its S3 route depends on it) and still no secret", () => {
    expect(listed("caddy")).toContain("S3_MODE");
  });
});
