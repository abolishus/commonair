// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * External Postgres and Valkey (S1-b), the parts that need no server:
 *
 * - the units selfhost.sh renders: with external state none depends on or orders after a bundled
 *   Postgres or Valkey unit, and with bundled state (the default) every unit is the release's file
 *   byte for byte, the repository's units rendered for the release;
 * - the pure rules of infra/selfhost/state-check.ts: the connection budget, the version, the
 *   owner's rights, Valkey's eviction policy, TLS failures in the operator's words, RESP, and the
 *   list of services that open a pool, checked against their code.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { buildReleases, host, quadletDir } from "../../scripts/selfhost/fake-host.ts";
import { renderUnits } from "../../scripts/selfhost/render.ts";
import { QUADLET_DIR, readUnitDir } from "../../scripts/selfhost/units.ts";
import { parseManifest } from "../../scripts/release/manifest.ts";
import {
  POOL_SERVICES,
  budgetFinding,
  connectionBudget,
  dn,
  encodeCommand,
  evictionFinding,
  infoField,
  inputFromEnv,
  parseReply,
  pgTarget,
  roleFindings,
  tlsFinding,
  valkeyTarget,
  versionFinding,
} from "../selfhost/state-check.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const TIMEOUT = 90_000;
vi.setConfig({ testTimeout: TIMEOUT });

const INSTALL = ["install", "--version", "v0.1.0", "--domain", "stream.example.org", "--email", "ops@example.org"];
const DEPENDENCY =
  /^(Wants|Requires|Requisite|BindsTo|PartOf|Upholds|After|Before)=.*commonair-(postgres|valkey)\.service/m;
const OPTIONAL = new Set([
  "commonair-whisper.container",
  "commonair-stripe-mock.container",
  "commonair-mailpit.container",
  "commonair-seed-harness.container",
]);

describe("the units selfhost.sh installs", () => {
  let releases: string;
  beforeAll(async () => {
    releases = await buildReleases();
  }, TIMEOUT);

  test(
    "bundled: the repository's units rendered for the release, byte for byte",
    () => {
      const h = host(releases);
      const r = h.run(INSTALL);
      expect(r.code, r.err).toBe(0);
      const manifest = parseManifest(readFileSync(join(h.home, "commonair/release-manifest.json"), "utf8"));
      const expected = renderUnits(readUnitDir(join(ROOT, QUADLET_DIR)), manifest);
      const got = readdirSync(quadletDir(h));
      expect(got.sort()).toEqual([...expected.keys()].filter((u) => !OPTIONAL.has(u)).sort());
      for (const u of got) expect(readFileSync(join(quadletDir(h), u), "utf8"), u).toBe(expected.get(u));
      // Their dependency on the bundled data units is untouched.
      expect(readFileSync(join(quadletDir(h), "commonair-migrate.container"), "utf8")).toMatch(
        /^After=commonair-postgres\.service$/m,
      );
    },
    TIMEOUT,
  );

  test(
    "external: no unit depends on or orders after a bundled Postgres or Valkey unit, and none is installed",
    () => {
      const h = host(releases);
      const ca = join(h.home, "ca.crt");
      writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
      const r = h.run(
        [
          ...INSTALL,
          "--database-url",
          "postgres://doadmin@db.example.com:25060/commonair?sslmode=verify-full",
          "--database-ca",
          ca,
          "--valkey-url",
          "rediss://cache.example.com:25061",
        ],
        { DATABASE_PASSWORD: "pw", VALKEY_PASSWORD: "vpw" },
      );
      expect(r.code, r.err).toBe(0);
      const got = readdirSync(quadletDir(h));
      for (const u of ["commonair-postgres.container", "commonair-postgres-data.volume", "commonair-valkey.container"])
        expect(got).not.toContain(u);
      for (const u of got) expect(readFileSync(join(quadletDir(h), u), "utf8"), u).not.toMatch(DEPENDENCY);
      // Every unit that had such an edge exists still, with its other lines.
      const units = readUnitDir(join(ROOT, QUADLET_DIR));
      const had = [...units].filter(([, t]) => DEPENDENCY.test(t)).map(([n]) => n);
      expect(had.length).toBeGreaterThan(5);
      for (const u of had.filter((n) => !OPTIONAL.has(n))) expect(got).toContain(u);
    },
    TIMEOUT,
  );
});

describe("state-check rules", () => {
  test("the services that open a pool are the ones whose code calls createDb with DATABASE_POOL_MAX", () => {
    const files: Record<string, string> = {
      api: "services/api/src/index.ts",
      chat: "services/chat/src/main.ts",
      media: "services/media/src/service.ts",
      origin: "services/origin/src/main.ts",
      worker: "services/worker/src/main.ts",
    };
    expect(Object.keys(files).sort()).toEqual([...POOL_SERVICES].sort());
    for (const [svc, f] of Object.entries(files)) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, svc).toMatch(/createDb\(\{[^}]*max: env\.DATABASE_POOL_MAX/s);
    }
    // No other service opens a pool.
    for (const svc of readdirSync(join(ROOT, "services")).filter((s) => !(s in files))) {
      const dir = join(ROOT, "services", svc, "src");
      const hits = Bun.spawnSync(["grep", "-rl", "createDb(", dir]).stdout.toString().trim();
      expect(hits, svc).toBe("");
    }
  });

  test("the budget: pool × services + migrate + 3 spare, against what a non-superuser may open", () => {
    // DigitalOcean's smallest node: 25 connections, 3 reserved for superusers.
    const small = connectionBudget({
      poolMax: 10,
      maxConnections: 25,
      superuserReserved: 3,
      reserved: 0,
      superuser: false,
    });
    expect(small).toEqual({ needed: 54, available: 22, ok: false, fittingPoolMax: 3 });
    const f = budgetFinding(small, 10);
    expect(f.level).toBe("error");
    expect(f.message).toContain(
      "54 connections needed (DATABASE_POOL_MAX 10 × 5 services + migrate + 3 spare), the server allows 22",
    );
    expect(f.fix).toContain("DATABASE_POOL_MAX=3");
    expect(f.fix).toContain("a bigger node");
    expect(
      connectionBudget({ poolMax: 3, maxConnections: 25, superuserReserved: 3, reserved: 0, superuser: false }).ok,
    ).toBe(true);
    // Exactly at the limit fits; reserved_connections (PG 16+) counts too; a superuser gets them all.
    expect(
      connectionBudget({ poolMax: 10, maxConnections: 54, superuserReserved: 0, reserved: 0, superuser: false }).ok,
    ).toBe(true);
    expect(
      connectionBudget({ poolMax: 10, maxConnections: 57, superuserReserved: 3, reserved: 1, superuser: false }).ok,
    ).toBe(false);
    expect(
      connectionBudget({ poolMax: 10, maxConnections: 54, superuserReserved: 3, reserved: 0, superuser: true }).ok,
    ).toBe(true);
    const tiny = connectionBudget({
      poolMax: 1,
      maxConnections: 6,
      superuserReserved: 3,
      reserved: 0,
      superuser: false,
    });
    expect(tiny.fittingPoolMax).toBe(0);
    expect(budgetFinding(tiny, 1).fix).toContain("a bigger node: this one leaves too few connections");
  });

  test.each([
    [170006, "17.6", "ok"],
    [180001, "18.1", "ok"],
    [160010, "16.10", "error"],
    [190000, "19.0", "error"],
  ])("version %s (%s): %s", (num, v, level) => {
    const f = versionFinding(num, v);
    expect(f.level).toBe(level);
    expect(f.message.includes("CommonAir needs 17 or 18")).toBe(level === "error");
  });

  test("the owner: CREATEROLE needed, a superuser only warned, schema rights checked", () => {
    const base = {
      name: "doadmin",
      superuser: false,
      createRole: true,
      createInDatabase: true,
      createInPublic: true,
      database: "commonair",
    };
    expect(roleFindings(base).map((f) => f.level)).toEqual(["ok"]);
    const noRole = roleFindings({ ...base, createRole: false });
    expect(noRole[0]).toMatchObject({
      level: "error",
      fix: 'ask your provider (or a superuser) for: ALTER ROLE "doadmin" CREATEROLE;',
    });
    expect(
      roleFindings({ ...base, superuser: true, createRole: false, createInDatabase: false }).map((f) => f.level),
    ).toEqual(["warning"]);
    const noSchema = roleFindings({ ...base, name: 'we"ird', createInDatabase: false, createInPublic: false });
    expect(noSchema.map((f) => f.fix)).toEqual([
      undefined,
      'GRANT CREATE ON DATABASE "commonair" TO "we""ird"; or make we"ird its owner',
      'ALTER SCHEMA public OWNER TO "we""ird"; (run by the database\'s owner)',
    ]);
  });

  test("Valkey's eviction policy from INFO", () => {
    const info = "# Memory\r\nused_memory:1000\r\nmaxmemory_policy:allkeys-lru\r\n";
    expect(infoField(info, "maxmemory_policy")).toBe("allkeys-lru");
    expect(evictionFinding("allkeys-lru")).toMatchObject({ level: "error" });
    expect(evictionFinding("noeviction").level).toBe("ok");
    expect(evictionFinding(undefined).message).toContain("maxmemory-policy is unknown");
  });

  test("TLS failures name the certificate and say what to do", () => {
    const cert = {
      subject: "CN=db.example.com",
      issuer: "CN=project CA",
      validTo: "Jan  1 00:00:00 2026 GMT",
      altNames: "DNS:db.example.com",
    };
    expect(tlsFinding("postgres", "db.example.com", undefined, cert, true)).toMatchObject({
      level: "ok",
      message: "postgres: TLS verified (CN=db.example.com)",
    });
    const expired = tlsFinding("postgres", "db.example.com", "CERT_HAS_EXPIRED", cert, true);
    expect(expired.message).toBe(
      "postgres: the server's certificate (subject CN=db.example.com; issuer CN=project CA) expired on Jan  1 00:00:00 2026 GMT",
    );
    const wrong = tlsFinding("valkey", "cache", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", cert, true);
    expect(wrong.message).toContain("does not verify against the CA given with --valkey-ca");
    expect(wrong.fix).toContain("--valkey-ca <file>");
    expect(tlsFinding("postgres", "x", "SELF_SIGNED_CERT_IN_CHAIN", cert, false).message).toContain(
      "the system's trusted CAs",
    );
    expect(tlsFinding("postgres", "10.0.0.5", "HOSTNAME_MISMATCH", cert, true).message).toContain(
      "is for DNS:db.example.com, not 10.0.0.5",
    );
    expect(tlsFinding("postgres", "h", "NO_TLS", undefined, false).message).toBe("postgres: h does not offer TLS");
    expect(tlsFinding("postgres", "h", "CERT_NOT_YET_VALID", cert, true).fix).toContain("synchronize the clock");
    expect(dn({ CN: "a", O: "b", OU: ["x", "y"] })).toBe("CN=a, O=b, OU=x+y");
  });

  test("RESP: commands encoded with byte lengths, replies parsed (incomplete ones wait)", () => {
    expect(encodeCommand(["AUTH", "pé"]).toString()).toBe("*2\r\n$4\r\nAUTH\r\n$3\r\npé\r\n");
    expect(parseReply(Buffer.from("+PONG\r\n"))?.reply).toEqual({ kind: "ok", value: "PONG" });
    expect(parseReply(Buffer.from("-NOPERM no\r\n"))?.reply).toEqual({ kind: "error", value: "NOPERM no" });
    expect(parseReply(Buffer.from("$5\r\nhel"))).toBeUndefined();
    const two = parseReply(Buffer.from("$5\r\nhello\r\n+OK\r\n"));
    expect(two?.reply.value).toBe("hello");
    expect(parseReply(two!.rest)?.reply.value).toBe("OK");
    expect(() => parseReply(Buffer.from("HTTP/1.1 400\r\n"))).toThrow("not a Valkey server");
  });

  test("targets: the parts of each URL, passwords decoded only where needed", () => {
    expect(pgTarget("postgres://doadmin:p%40ss@db.example.com:25060/commonair?sslmode=verify-full")).toMatchObject({
      host: "db.example.com",
      port: 25060,
      user: "doadmin",
      database: "commonair",
      sslmode: "verify-full",
    });
    expect(pgTarget("postgresql://o@[2001:db8::5]/x").host).toBe("[2001:db8::5]");
    expect(valkeyTarget("rediss://default:p%2Fw@cache:25061/2")).toEqual({
      host: "cache",
      port: 25061,
      user: "default",
      password: "p/w",
      db: 2,
      tls: true,
    });
    expect(valkeyTarget("redis://:x@cache").tls).toBe(false);
    expect(() => valkeyTarget("http://cache")).toThrow("not a redis:// or rediss:// URL");
  });

  test("input from the environment: the unit's own names work too", () => {
    expect(inputFromEnv({ DATABASE_URL: "postgres://a@b/c", VALKEY_URL: "rediss://d", STATE_POOL_MAX: "4" })).toEqual({
      pgUrl: "postgres://a@b/c",
      pgCa: undefined,
      valkeyUrl: "rediss://d",
      valkeyCa: undefined,
      poolMax: 4,
      allowInsecureDatabase: false,
      allowInsecureValkey: false,
    });
    expect(() => inputFromEnv({ STATE_POOL_MAX: "0" })).toThrow("positive integer");
  });
});
