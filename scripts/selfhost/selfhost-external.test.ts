// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * External Postgres and Valkey in scripts/selfhost.sh (S1-b, ADR 0032 §3): the bundled
 * containers stay the default, exactly as before, and --database-url / --valkey-url install
 * against a managed service instead. Runs the script on the fake host of fake-host.ts, whose
 * podman stub also plays the preflight (infra/selfhost/state-check.ts, tested against real
 * servers in infra/tests/selfhost-external.int.test.ts).
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";
import {
  type Host,
  type Run,
  buildReleases,
  envFile,
  envOf,
  host,
  quadletDir,
  secretPath,
  systemdDir,
} from "./fake-host.ts";

const TIMEOUT = 90_000;
vi.setConfig({ testTimeout: TIMEOUT });

let releases: string;
beforeAll(async () => {
  releases = await buildReleases();
}, TIMEOUT);

const DOMAIN = "stream.example.org";
const INSTALL = ["install", "--version", "v0.1.0", "--domain", DOMAIN, "--email", "ops@example.org"];
const DB_URL = "postgres://doadmin@db.example.com:25060/commonair?sslmode=verify-full";
const VK_URL = "rediss://default@cache.example.com:25061";
// Every URL-reserved character, a quote, a space and a non-ASCII letter: percent-encoded in the
// URLs, and the same password again after decoding.
const DB_PASSWORD = "p@ss:w/o?r#d[1]%20&=+ $'\"é";
const VK_PASSWORD = "vk/pass+word=@:";
const PASSWORDS = { DATABASE_PASSWORD: DB_PASSWORD, VALKEY_PASSWORD: VK_PASSWORD };
const PG_CA = "-----BEGIN CERTIFICATE-----\nMIIBpgCA0pg\n-----END CERTIFICATE-----\n";
const VK_CA = "-----BEGIN CERTIFICATE-----\nMIIBvalkeyCA\n-----END CERTIFICATE-----\n";

/** The CA files in the host's home (where an operator keeps them). */
function cas(h: Host): { pg: string; vk: string } {
  const pg = join(h.home, "ca-certificate.crt");
  const vk = join(h.home, "valkey-ca.crt");
  writeFileSync(pg, PG_CA);
  writeFileSync(vk, VK_CA);
  return { pg, vk };
}
const external = (c: { pg: string; vk: string }) => [
  "--database-url",
  DB_URL,
  "--database-ca",
  c.pg,
  "--valkey-url",
  VK_URL,
  "--valkey-ca",
  c.vk,
];

const expectOk = (r: Run) => expect(r.code, `${r.out}\n${r.err}`).toBe(0);
const expectRefused = (r: Run, ...parts: string[]) => {
  expect(r.code, `${r.out}\n${r.err}`).toBe(1);
  for (const p of parts) expect(r.err).toContain(p);
};
const installed = (h: Host) => readdirSync(quadletDir(h)).sort();
const releaseQuadlet = (h: Host) => join(h.home, "commonair/quadlet");
const BUNDLED_STATE_UNITS = [
  "commonair-postgres.container",
  "commonair-postgres-data.volume",
  "commonair-valkey.container",
];
const NOT_INSTALLED = new Set([
  "commonair-whisper.container",
  "commonair-stripe-mock.container",
  "commonair-mailpit.container",
  "commonair-seed-harness.container",
]);
const DEPENDENCY =
  /^(Wants|Requires|Requisite|BindsTo|PartOf|Upholds|After|Before)=.*commonair-(postgres|valkey)\.service/m;
const secret = (h: Host, n: string) => readFileSync(secretPath(h, n), "utf8");
const created = (h: Host) =>
  h
    .calls()
    .filter((c) => c.startsWith("podman secret create"))
    .map((c) => c.split(" ").at(-2));
const keysOf = (h: Host, unit: string) =>
  readFileSync(join(h.home, "commonair/infra/selfhost/env", unit.replace(/\.container$/, ".keys")), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z]/.test(l));
const instanceChanged = (h: Host, before: string) => readFileSync(envFile(h), "utf8") !== before;

describe("bundled (no flag): the default, as before", () => {
  let h: Host;
  let r: Run;
  beforeAll(() => {
    h = host(releases);
    r = h.run(INSTALL);
  }, TIMEOUT);

  test("installs", () => expectOk(r));

  test("every unit is the release's file, byte for byte, Postgres and Valkey included", () => {
    const rel = readdirSync(releaseQuadlet(h)).filter((f) => !NOT_INSTALLED.has(f));
    expect(installed(h)).toEqual(rel.sort());
    for (const u of rel)
      expect(readFileSync(join(quadletDir(h), u), "utf8"), u).toBe(readFileSync(join(releaseQuadlet(h), u), "utf8"));
    for (const u of BUNDLED_STATE_UNITS) expect(installed(h)).toContain(u);
    expect(readdirSync(systemdDir(h))).toContain("commonair-backup.timer");
  });

  test("the collector's keys (contract §3.7) point at the bundled containers", () => {
    const env = envOf(h);
    expect(env).toMatchObject({
      PG_MONITOR_ENDPOINT: "postgres:5432",
      PG_MONITOR_USER: "commonair_monitor",
      PG_MONITOR_TLS: "disable",
      VALKEY_MONITOR_ENDPOINT: "valkey:6379",
      VALKEY_MONITOR_USER: "",
      VALKEY_MONITOR_TLS: "off",
      OBSERVABILITY_STATE_MODE: "bundled",
    });
    // Generated once, so migrate creates the monitor role on the bundled stack too.
    expect(env.POSTGRES_MONITOR_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    for (const k of ["STATE_MODE", "DATABASE_OWNER_URL", "DATABASE_ALLOW_INSECURE", "VALKEY_ALLOW_INSECURE"])
      expect(env[k], k).toBeUndefined();
    expect(env.DATABASE_URL).toBe(`postgres://commonair_app:${env.POSTGRES_APP_PASSWORD}@postgres:5432/commonair`);
    expect(env.VALKEY_URL).toBe(`redis://:${env.VALKEY_PASSWORD}@valkey:6379`);
  });

  test("the secrets: as before, plus the collector's two (Valkey's is its own password)", () => {
    const env = envOf(h);
    expect(created(h)).toEqual([
      "commonair-database-url",
      "commonair-owner-database-url",
      "commonair-grafana-admin-password",
      "commonair-valkey-url",
      "commonair-pg-monitor-password",
      "commonair-valkey-monitor-password",
    ]);
    expect(secret(h, "commonair-pg-monitor-password")).toBe(env.POSTGRES_MONITOR_PASSWORD);
    expect(secret(h, "commonair-valkey-monitor-password")).toBe(env.VALKEY_PASSWORD);
    expect(existsSync(secretPath(h, "commonair-pg-ca"))).toBe(false);
  });

  test("no preflight runs and status shows no external rows", () => {
    expect(h.calls().filter((c) => c.includes("state-check"))).toEqual([]);
    const s = h.run(["status"]);
    expectOk(s);
    expect(s.out).not.toContain("state:");
    expect(s.out).not.toContain("external");
    expect(s.out).toMatch(/^last backup: /m);
  });

  test(
    "an upgrade keeps bundled state: the WAL-G backup first, no preflight, migrate once",
    () => {
      h.clearLog();
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      const calls = h.calls();
      expect(calls).toContain("systemctl --user start commonair-backup.service");
      expect(calls.filter((c) => c.includes("state-check"))).toEqual([]);
      expect(calls.filter((c) => c === "systemctl --user start commonair-migrate.service")).toHaveLength(1);
      for (const u of BUNDLED_STATE_UNITS) expect(installed(h)).toContain(u);
      expect(envOf(h).OBSERVABILITY_STATE_MODE).toBe("bundled");
    },
    TIMEOUT,
  );

  test("switching to external is refused: names both modes and the procedure, changes nothing", () => {
    const before = readFileSync(envFile(h), "utf8");
    h.clearLog();
    const x = h.run(["install", "--reinstall", "--database-url", DB_URL, "--valkey-url", VK_URL], PASSWORDS);
    expectRefused(
      x,
      "the bundled Postgres and Valkey on this host (bundled)",
      "external servers (--database-url, --valkey-url)",
      "data migration, not a flag",
      "docs/self-hosting/managed-services.md",
    );
    expect(instanceChanged(h, before)).toBe(false);
    expect(h.calls().filter((c) => c.startsWith("podman") || c.startsWith("curl"))).toEqual([]);
  });

  test("--database-ca alone does nothing for the bundled Postgres: refused", () => {
    const c = cas(h);
    expectRefused(
      h.run(["install", "--reinstall", "--database-ca", c.pg]),
      "apply to external Postgres and Valkey only",
    );
  });
});

describe("external Postgres and Valkey", () => {
  let h: Host;
  let r: Run;
  let c: { pg: string; vk: string };
  beforeAll(() => {
    h = host(releases, { recordArgv: true });
    c = cas(h);
    r = h.run([...INSTALL, ...external(c)], PASSWORDS);
  }, TIMEOUT);

  test("installs", () => expectOk(r));

  test("no bundled Postgres or Valkey unit, volume, image or backup timer", () => {
    for (const u of BUNDLED_STATE_UNITS) expect(installed(h)).not.toContain(u);
    const rel = readdirSync(releaseQuadlet(h)).filter((f) => !NOT_INSTALLED.has(f) && !BUNDLED_STATE_UNITS.includes(f));
    expect(installed(h)).toEqual(rel.sort());
    expect(h.calls().filter((x) => /^podman pull .*(\/postgres:|valkey)/.test(x))).toEqual([]);
    expect(readdirSync(systemdDir(h)).filter((f) => f.startsWith("commonair-backup."))).toEqual([]);
    expect(h.calls().find((x) => x.startsWith("systemctl --user enable --now"))).not.toContain(
      "commonair-backup.timer",
    );
  });

  test("no installed unit orders after or depends on a bundled Postgres or Valkey unit", () => {
    for (const u of installed(h)) expect(readFileSync(join(quadletDir(h), u), "utf8"), u).not.toMatch(DEPENDENCY);
    // migrate keeps everything else it had.
    const migrate = readFileSync(join(quadletDir(h), "commonair-migrate.container"), "utf8");
    expect(migrate).toContain("Secret=commonair-owner-database-url,type=env,target=DATABASE_URL");
  });

  test("each unit whose key list names a CA key mounts that CA where the key points, and only those", () => {
    for (const u of installed(h).filter((f) => f.endsWith(".container"))) {
      const text = readFileSync(join(quadletDir(h), u), "utf8");
      const keys = existsSync(join(h.home, "commonair/infra/selfhost/env", u.replace(/\.container$/, ".keys")))
        ? keysOf(h, u)
        : [];
      expect(text.includes("Secret=commonair-pg-ca,type=mount,target=/run/secrets/commonair-pg-ca,mode=0444"), u).toBe(
        keys.includes("DATABASE_CA_FILE"),
      );
      expect(
        text.includes("Secret=commonair-valkey-ca,type=mount,target=/run/secrets/commonair-valkey-ca,mode=0444"),
        u,
      ).toBe(keys.includes("VALKEY_CA_FILE"));
    }
    for (const u of ["api", "chat", "media", "origin", "worker", "migrate"])
      expect(readFileSync(join(quadletDir(h), `commonair-${u}.container`), "utf8"), u).toContain(
        "Secret=commonair-pg-ca,",
      );
    // The rest of each unit is the release's, line for line.
    const api = readFileSync(join(quadletDir(h), "commonair-api.container"), "utf8").split("\n");
    const rel = readFileSync(join(releaseQuadlet(h), "commonair-api.container"), "utf8").split("\n");
    const dropped = rel.filter((l) => !api.includes(l));
    expect(dropped).toEqual(["Wants=commonair-valkey.service", "After=commonair-valkey.service"]);
  });

  test("the env file records the choice, the URLs without passwords, the CA paths and §3.7's keys", () => {
    const env = envOf(h);
    expect(env).toMatchObject({
      STATE_MODE: "external",
      DATABASE_OWNER_URL: DB_URL,
      VALKEY_URL: VK_URL,
      DATABASE_CA_FILE: "/run/secrets/commonair-pg-ca",
      VALKEY_CA_FILE: "/run/secrets/commonair-valkey-ca",
      DATABASE_ALLOW_INSECURE: "false",
      VALKEY_ALLOW_INSECURE: "false",
      PG_MONITOR_ENDPOINT: "db.example.com:25060",
      PG_MONITOR_USER: "commonair_monitor",
      PG_MONITOR_TLS: "verify-full",
      VALKEY_MONITOR_ENDPOINT: "cache.example.com:25061",
      VALKEY_MONITOR_USER: "default",
      VALKEY_MONITOR_TLS: "on",
      OBSERVABILITY_STATE_MODE: "external",
    });
    expect(env.DATABASE_URL).toBe(
      `postgres://commonair_app:${env.POSTGRES_APP_PASSWORD}@db.example.com:25060/commonair?sslmode=verify-full`,
    );
    expect(env.POSTGRES_MONITOR_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
  });

  test("the secrets: the URLs carry the passwords percent-encoded, and decode to them exactly", () => {
    const owner = new URL(secret(h, "commonair-owner-database-url"));
    expect(owner.username).toBe("doadmin");
    expect(decodeURIComponent(owner.password)).toBe(DB_PASSWORD);
    expect(`${owner.host}${owner.pathname}${owner.search}`).toBe("db.example.com:25060/commonair?sslmode=verify-full");
    const app = new URL(secret(h, "commonair-database-url"));
    expect(app.username).toBe("commonair_app");
    expect(decodeURIComponent(app.password)).toBe(envOf(h).POSTGRES_APP_PASSWORD);
    const vk = new URL(secret(h, "commonair-valkey-url"));
    expect(`${vk.protocol}//${vk.username}@${vk.host}`).toBe(VK_URL);
    expect(decodeURIComponent(vk.password)).toBe(VK_PASSWORD);
    expect(secret(h, "commonair-valkey-monitor-password")).toBe(VK_PASSWORD);
    expect(secret(h, "commonair-pg-monitor-password")).toBe(envOf(h).POSTGRES_MONITOR_PASSWORD);
    expect(secret(h, "commonair-pg-ca")).toBe(PG_CA);
    expect(secret(h, "commonair-valkey-ca")).toBe(VK_CA);
  });

  test("no password in commonair.env, a unit file, the output or any command line", () => {
    const encoded = [encodeURIComponent(DB_PASSWORD), encodeURIComponent(VK_PASSWORD)];
    const places = {
      "commonair.env": readFileSync(envFile(h), "utf8"),
      units: installed(h)
        .map((u) => readFileSync(join(quadletDir(h), u), "utf8"))
        .join("\n"),
      output: `${r.out}\n${r.err}`,
      argv: `${h.calls().join("\n")}\n${h.argv()}`,
    };
    expect(h.argv()).toMatch(/^awk /m);
    for (const [where, text] of Object.entries(places))
      for (const v of [DB_PASSWORD, VK_PASSWORD, "p@ss:w", ...encoded]) expect(text, `${where}: ${v}`).not.toContain(v);
  });

  test("the preflight ran before anything was written, got the URLs by name and the CAs as a mount", () => {
    const calls = h.calls();
    const preflight = calls.findIndex((x) => x.includes("state-check.ts preflight"));
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(calls.findIndex((x) => x.includes("/tools/init-env.js")));
    expect(preflight).toBeLessThan(calls.findIndex((x) => x.startsWith("podman secret create")));
    const args = h.state("state-check-preflight.args");
    expect(args).toContain("--env STATE_PG_URL --env STATE_VALKEY_URL");
    expect(args).toContain(
      "-e STATE_PG_CA=/run/state-check/pg-ca.pem -e STATE_VALKEY_CA=/run/state-check/valkey-ca.pem",
    );
    expect(args).toContain("-e STATE_POOL_MAX=10");
    expect(args).toMatch(/ bun infra\/selfhost\/state-check\.ts preflight$/m);
    const got = h.state("state-check-preflight.env");
    expect(decodeURIComponent(new URL(/^STATE_PG_URL=(.*)$/m.exec(got)![1]!).password)).toBe(DB_PASSWORD);
    expect(readFileSync(join(h.dir, "state/state-check-preflight.mount/pg-ca.pem"), "utf8")).toBe(PG_CA);
    expect(r.err).toContain("ok: postgres: TLS verified (CN=db.example.com)");
    // The copy of the CAs is gone afterwards.
    expect(readdirSync(join(h.dir, "tmp")).flatMap((d) => readdirSync(join(h.dir, "tmp", d)))).toEqual([]);
  });

  test("status: the state line, and external rows from the servers, through the stored secrets", () => {
    h.clearLog();
    const s = h.run(["status"]);
    expectOk(s);
    expect(s.out).toContain(
      "state:     external Postgres at db.example.com:25060/commonair, external Valkey at cache.example.com:25061",
    );
    expect(s.out).toMatch(
      /^ {2}commonair-postgres +external +reachable, TLS verified, PostgreSQL 17\.6, 3\/22 connections in use/m,
    );
    expect(s.out).toMatch(/^ {2}commonair-valkey +external +reachable, TLS verified, PING ok/m);
    expect(s.out).toContain("last backup: the provider's");
    const args = h.state("state-check-status.args");
    expect(args).toContain("--secret commonair-database-url,type=env,target=STATE_PG_URL");
    expect(args).toContain("--secret commonair-valkey-url,type=env,target=STATE_VALKEY_URL");
    expect(args).toContain("--secret commonair-pg-ca,type=mount,target=/run/secrets/commonair-pg-ca,mode=0444");
    expect(h.state("state-check-status.env")).not.toMatch(/^STATE_PG_URL=./m);
    for (const v of [DB_PASSWORD, VK_PASSWORD]) expect(s.out + s.err).not.toContain(v);
  });

  test(
    "upgrade keeps external state with no password given: the stored secrets, migrate once, no WAL-G",
    () => {
      h.clearLog();
      const u = h.run(["upgrade", "--version", "v0.2.0"]);
      expectOk(u);
      const calls = h.calls();
      expect(calls.filter((x) => x === "systemctl --user start commonair-migrate.service")).toHaveLength(1);
      expect(calls).not.toContain("systemctl --user start commonair-backup.service");
      expect(u.err).toContain("the provider's point-in-time recovery covers the upgrade");
      const args = h.state("state-check-preflight.args");
      expect(args).toContain("--secret commonair-owner-database-url,type=env,target=STATE_PG_URL");
      expect(args).toContain("--secret commonair-pg-ca,type=mount");
      // The owner's and Valkey's secrets stay as stored; the app URL is rebuilt.
      expect(created(h)).toEqual([
        "commonair-database-url",
        "commonair-grafana-admin-password",
        "commonair-pg-monitor-password",
      ]);
      for (const x of BUNDLED_STATE_UNITS) expect(installed(h)).not.toContain(x);
      expect(envOf(h)).toMatchObject({
        STATE_MODE: "external",
        DATABASE_OWNER_URL: DB_URL,
        OBSERVABILITY_STATE_MODE: "external",
      });
      expect(readlinkSync(join(h.home, "commonair"))).toMatch(/0\.2\.0$/);
    },
    TIMEOUT,
  );

  test("upgrade without the CA's secret asks for it again rather than dropping TLS", () => {
    rmSync(secretPath(h, "commonair-pg-ca"));
    const before = readlinkSync(join(h.home, "commonair"));
    h.clearLog();
    const x = h.run(["upgrade", "--version", "v0.1.0"]);
    expectRefused(x, "the Podman secret commonair-pg-ca is missing", "--database-ca <file>");
    expect(readlinkSync(join(h.home, "commonair"))).toBe(before);
    expect(h.calls().filter((x) => x.startsWith("curl") || x.startsWith("podman pull"))).toEqual([]);
    expect(envOf(h).DATABASE_CA_FILE).toBe("/run/secrets/commonair-pg-ca");
  });

  test(
    "a re-install with --database-ca restores it (and replaces a CA the same way)",
    () => {
      writeFileSync(c.pg, PG_CA.replace("MIIBpgCA0pg", "MIIBrotated"));
      expectOk(h.run(["install", "--reinstall", "--database-ca", c.pg]));
      expect(secret(h, "commonair-pg-ca")).toContain("MIIBrotated");
    },
    TIMEOUT,
  );

  test("upgrade takes no URL flags: the servers are chosen at install", () => {
    expectRefused(h.run(["upgrade", "--version", "v0.2.0", "--database-url", DB_URL]), "chosen at install");
  });

  test("a different database server or database is refused: its data would stay behind", () => {
    const before = readFileSync(envFile(h), "utf8");
    const x = h.run(
      [
        "install",
        "--reinstall",
        "--database-url",
        "postgres://doadmin@other.example.com:25060/commonair?sslmode=verify-full",
      ],
      PASSWORDS,
    );
    expectRefused(
      x,
      "keeps its database at db.example.com:25060/commonair",
      "other.example.com:25060/commonair",
      "managed-services.md",
    );
    expect(instanceChanged(h, before)).toBe(false);
  });

  test(
    "a new owner user on the same database, and another Valkey user (a warning), re-install",
    () => {
      const x = h.run(
        [
          "install",
          "--reinstall",
          "--database-url",
          "postgres://commonair_owner@db.example.com:25060/commonair?sslmode=verify-full",
          "--valkey-url",
          "rediss://commonair@cache.example.com:25061",
        ],
        { DATABASE_PASSWORD: "new-owner-pass", VALKEY_PASSWORD: "acl-user-pass" },
      );
      expectOk(x);
      expect(x.err).toContain("queued jobs, sessions and caches on the old one are not carried over");
      expect(new URL(secret(h, "commonair-owner-database-url")).username).toBe("commonair_owner");
      expect(new URL(secret(h, "commonair-valkey-url")).username).toBe("commonair");
      expect(envOf(h)).toMatchObject({
        VALKEY_MONITOR_USER: "commonair",
        VALKEY_URL: "rediss://commonair@cache.example.com:25061",
      });
      // The CAs carry over.
      expect(envOf(h).DATABASE_CA_FILE).toBe("/run/secrets/commonair-pg-ca");
    },
    TIMEOUT,
  );

  test("switching back to bundled is refused: an env file that lost STATE_MODE", () => {
    const before = readFileSync(envFile(h), "utf8");
    writeFileSync(envFile(h), before.replace(/^STATE_MODE=external\n/m, ""));
    const x = h.run(["install", "--reinstall"]);
    expectRefused(
      x,
      "external Postgres and Valkey (external, db.example.com:25060/commonair)",
      "the bundled ones",
      "data migration",
    );
    const st = h.run(["status"]);
    expect(st.code).toBe(1);
    writeFileSync(envFile(h), before);
  });

  test("reset-staging and seed-mode open refuse external state", () => {
    writeFileSync(envFile(h), `${readFileSync(envFile(h), "utf8")}DEMO_SEED_FULL=true\n`);
    expectRefused(
      h.run(["reset-staging", "--confirm", DOMAIN]),
      "reset-staging refused: this instance uses external Postgres and Valkey",
    );
    expectRefused(
      h.run(["seed-mode", "open", "--confirm", DOMAIN]),
      "seed-mode open refused: this instance uses external",
    );
  });
});

describe("flags and their refusals (nothing happens on the host)", () => {
  let h: Host;
  let c: { pg: string; vk: string };
  beforeAll(() => {
    h = host(releases);
    c = cas(h);
  });
  const expectRefusedHere = (args: string[], env: Record<string, string>, ...parts: string[]) => {
    h.clearLog();
    const x = h.run([...INSTALL, ...args], env);
    expectRefused(x, ...parts);
    expect(h.calls().filter((y) => y.startsWith("podman") || y.startsWith("curl"))).toEqual([]);
    expect(existsSync(envFile(h))).toBe(false);
    return x;
  };

  test("a password in either URL", () => {
    const x = expectRefusedHere(
      [
        "--database-url",
        "postgres://doadmin:hunter2@db.example.com:25060/commonair?sslmode=verify-full",
        "--valkey-url",
        VK_URL,
      ],
      PASSWORDS,
      "--database-url holds a password",
      "ps",
      "DATABASE_PASSWORD",
    );
    expect(x.err).not.toContain("hunter2");
    expectRefusedHere(
      ["--database-url", DB_URL, "--valkey-url", "rediss://:hunter2@cache.example.com:25061"],
      PASSWORDS,
      "--valkey-url holds a password",
    );
  });

  test.each([
    ["--database-password", "x"],
    ["--valkey-password", "x"],
    ["--db-pass", "x"],
  ])("%s is never a flag", (flag, v) => {
    expectRefusedHere([flag, v], {}, "passwords are never flags", "DATABASE_PASSWORD and VALKEY_PASSWORD");
  });

  test("sslmode=require is refused without --allow-insecure-database", () => {
    expectRefusedHere(
      ["--database-url", DB_URL.replace("verify-full", "require"), "--valkey-url", VK_URL],
      PASSWORDS,
      "sslmode=require: the server's certificate and name would not be verified",
      "--allow-insecure-database",
    );
    expectRefusedHere(
      ["--database-url", DB_URL.replace("?sslmode=verify-full", ""), "--valkey-url", VK_URL],
      PASSWORDS,
      "sslmode=prefer",
    );
  });

  test("a CA with a weaker sslmode, and redis:// without --allow-insecure-valkey", () => {
    expectRefusedHere(
      [
        "--database-url",
        DB_URL.replace("verify-full", "require"),
        "--allow-insecure-database",
        "--database-ca",
        c.pg,
        "--valkey-url",
        VK_URL,
      ],
      PASSWORDS,
      "--database-ca is used with sslmode=verify-full only",
    );
    expectRefusedHere(
      ["--database-url", DB_URL, "--valkey-url", VK_URL.replace("rediss", "redis")],
      PASSWORDS,
      "without TLS",
      "--allow-insecure-valkey",
    );
  });

  test("an insecure flag without its URL", () => {
    expectRefusedHere(["--allow-insecure-database"], {}, "--allow-insecure-database goes with --database-url");
    expectRefusedHere(["--allow-insecure-valkey"], {}, "--allow-insecure-valkey goes with --valkey-url");
  });

  test("one of the two URLs alone", () => {
    expectRefusedHere(["--database-url", DB_URL], PASSWORDS, "--database-url and --valkey-url go together");
    expectRefusedHere(["--valkey-url", VK_URL], PASSWORDS, "--database-url and --valkey-url go together");
  });

  test.each([
    ["mysql://u@h/db"],
    ["postgres://db.example.com/commonair?sslmode=verify-full"],
    ["postgres://u@db.example.com:25060?sslmode=verify-full"],
    ["postgres://u@db.example.com/db?sslmode=verify-full&sslrootcert=/x"],
    ["postgres://u@db example.com/db"],
  ])("not a database URL: %s", (url) => {
    expectRefusedHere(["--database-url", url, "--valkey-url", VK_URL], PASSWORDS, "not a database URL");
  });

  test("a CA file that is not PEM, or that holds a key", () => {
    const der = join(h.home, "ca.der");
    writeFileSync(der, Buffer.from([0x30, 0x82, 0x01, 0x0a]));
    expectRefusedHere(
      [...external({ ...c, pg: der })],
      PASSWORDS,
      "is not a PEM certificate",
      "openssl x509 -inform der",
    );
    const key = join(h.home, "key.pem");
    writeFileSync(key, `${PG_CA}-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n`);
    expectRefusedHere([...external({ ...c, pg: key })], PASSWORDS, "holds a private key");
    expectRefusedHere([...external({ ...c, vk: join(h.home, "missing.crt") })], PASSWORDS, "no such readable file");
  });

  test("no password in the environment and no terminal: refused, naming what is missing", () => {
    h.clearLog();
    const x = h.run([...INSTALL, ...external(c)], { VALKEY_PASSWORD: VK_PASSWORD });
    expectRefused(x, "need their passwords; missing: DATABASE_PASSWORD", "never as flags");
    expect(h.calls().filter((y) => y.startsWith("curl") || y.startsWith("podman pull"))).toEqual([]);
    expect(existsSync(envFile(h))).toBe(false);
  });

  test("a failed preflight installs and writes nothing", () => {
    h.clearLog();
    const x = h.run([...INSTALL, ...external(c)], { ...PASSWORDS, STUB_PREFLIGHT_FAIL: "doadmin lacks CREATEROLE" });
    expectRefused(
      x,
      "error: postgres: doadmin lacks CREATEROLE",
      "fix: what the operator does",
      "failed the preflight; nothing was installed",
    );
    expect(existsSync(envFile(h))).toBe(false);
    expect(existsSync(quadletDir(h))).toBe(false);
    expect(h.calls().filter((y) => y.startsWith("podman secret"))).toEqual([]);
  });
});

describe("hosts and the insecure flags", () => {
  test(
    "an IPv6 literal and a private network without TLS: accepted, recorded, warned by the preflight's rules",
    () => {
      const h = host(releases);
      const r = h.run(
        [
          ...INSTALL,
          "--database-url",
          "postgresql://owner@[2001:db8::5]:5432/commonair?sslmode=disable",
          "--allow-insecure-database",
          "--valkey-url",
          "redis://[2001:db8::6]/2",
          "--allow-insecure-valkey",
        ],
        { ...PASSWORDS, DATABASE_POOL_MAX: "3" },
      );
      expectOk(r);
      expect(r.err).toContain(
        "WARNING: --allow-insecure-database: the database's certificate is not verified (sslmode=disable)",
      );
      expect(r.err).toContain(
        "WARNING: --allow-insecure-valkey: Valkey's password and every job cross the network without TLS",
      );
      expect(envOf(h)).toMatchObject({
        DATABASE_OWNER_URL: "postgresql://owner@[2001:db8::5]:5432/commonair?sslmode=disable",
        DATABASE_ALLOW_INSECURE: "true",
        VALKEY_ALLOW_INSECURE: "true",
        DATABASE_CA_FILE: "",
        VALKEY_CA_FILE: "",
        DATABASE_POOL_MAX: "3",
        PG_MONITOR_ENDPOINT: "[2001:db8::5]:5432",
        PG_MONITOR_TLS: "disable",
        VALKEY_MONITOR_ENDPOINT: "[2001:db8::6]:6379",
        VALKEY_MONITOR_USER: "",
        VALKEY_MONITOR_TLS: "off",
      });
      const args = h.state("state-check-preflight.args");
      expect(args).toContain("-e STATE_ALLOW_INSECURE_DATABASE=true");
      expect(args).toContain("-e STATE_ALLOW_INSECURE_VALKEY=true");
      expect(args).toContain("-e STATE_POOL_MAX=3");
      expect(args).not.toContain("STATE_PG_CA");
      const vk = new URL(secret(h, "commonair-valkey-url"));
      expect(vk.hostname).toBe("[2001:db8::6]");
      expect(vk.pathname).toBe("/2");
      expect(decodeURIComponent(vk.password)).toBe(VK_PASSWORD);
      for (const u of installed(h))
        expect(readFileSync(join(quadletDir(h), u), "utf8")).not.toContain("commonair-pg-ca");
    },
    TIMEOUT,
  );
});
