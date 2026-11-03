// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * selfhost.sh's preflight and status checks of an external Postgres and Valkey
 * (infra/selfhost/state-check.ts, S1-b) against real servers: the Postgres and Valkey images the
 * stack pins, TLS only, with a CA this test makes, the way a managed provider hands them out.
 * Postgres has a CREATEROLE owner (DigitalOcean's doadmin, no superuser) and a role without
 * CREATEROLE. Valkey's default user has only a password (DigitalOcean's model), a second ACL user
 * exists, and both are denied @admin and @dangerous except INFO, which BullMQ needs. Needs podman;
 * CI's integration job has it, so it refuses to skip there.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import {
  POSTGRES_IMAGE,
  type TestCerts,
  VALKEY_IMAGE,
  hostPort,
  makeTestCerts,
  podman,
  podmanAvailable,
  podmanOk,
} from "../../packages/db/tests/external-owner-tls.ts";
import { testOwnerArgs } from "../../scripts/test-owner.ts";
import { type CheckInput, checkPostgres, checkValkey } from "../selfhost/state-check.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 600_000 });

const HAVE_PODMAN = podmanAvailable();
if (!HAVE_PODMAN) {
  if (process.env.CI) throw new Error("selfhost-external.int.test.ts needs podman, and CI must run it");
  console.warn("\n*** selfhost-external.int.test.ts SKIPPED: podman is not available here ***\n");
}

const SUFFIX = crypto.randomUUID().slice(0, 8);
const PG = `commonair-s1b-pg-${SUFFIX}`;
const VK = `commonair-s1b-valkey-${SUFFIX}`;
// URL-reserved characters on purpose: the URLs carry them percent-encoded.
const OWNER_PASSWORD = `o@w:n/e?r#${SUFFIX}%`;
const PLAIN_PASSWORD = `plain-${SUFFIX}`;
const VALKEY_PASSWORD = `v${crypto.randomUUID().replaceAll("-", "")}`;
const ACL_PASSWORD = `a${crypto.randomUUID().replaceAll("-", "")}`;
const ADMIN_PASSWORD = `x${crypto.randomUUID().replaceAll("-", "")}`;

const SCRIPT = new URL("../selfhost/state-check.ts", import.meta.url).pathname;
let certs: TestCerts;
let pgPort = 0;
let vkPort = 0;

const pgUrl = (user: string, password: string, db = "commonair", sslmode = "verify-full") =>
  `postgres://${user}:${encodeURIComponent(password)}@localhost:${pgPort}/${db}?sslmode=${sslmode}`;
const input = (over: Partial<CheckInput>): CheckInput => ({
  poolMax: 10,
  allowInsecureDatabase: false,
  allowInsecureValkey: false,
  ...over,
});

function psql(sql: string): string {
  return podmanOk(["exec", "-u", "postgres", PG, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-c", sql]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (!HAVE_PODMAN) return;
  certs = makeTestCerts();
  await Bun.write(
    join(certs.dir, "pg_hba.conf"),
    "local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::/0 scram-sha-256\n",
  );
  const pgStart = [
    "set -eu",
    "install -d -o postgres -g postgres -m 0700 /etc/pgtls",
    "install -o postgres -g postgres -m 0600 /certs/server.key /etc/pgtls/server.key",
    "install -o postgres -g postgres -m 0644 /certs/server.crt /certs/pg_hba.conf /etc/pgtls/",
    "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/pgtls/server.crt" +
      " -c ssl_key_file=/etc/pgtls/server.key -c hba_file=/etc/pgtls/pg_hba.conf -c max_connections=25",
  ].join("\n");
  podmanOk(
    [
      "run",
      "-d",
      "--name",
      PG,
      ...testOwnerArgs(),
      "-e",
      `POSTGRES_PASSWORD=${crypto.randomUUID()}`,
      "-v",
      `${certs.dir}:/certs:ro,Z`,
      "-p",
      "127.0.0.1::5432",
      "--entrypoint",
      "sh",
      POSTGRES_IMAGE,
      "-c",
      pgStart,
    ],
    { timeoutMs: 600_000 },
  );
  // Users with ACL rules as a provider would set them: the default user (password only) and an
  // ACL user, both without @admin and @dangerous but with INFO; an admin for the test's own CONFIG.
  const rules = '"~*" "&*" +@all -@admin -@dangerous +info';
  const vkStart = [
    "set -eu",
    "install -d -m 0755 /tmp/tls",
    "install -m 0644 /certs/server.crt /certs/server.key /certs/commonair-test-ca.crt /tmp/tls/",
    "exec docker-entrypoint.sh valkey-server --port 0 --tls-port 6380 --tls-cert-file /tmp/tls/server.crt" +
      " --tls-key-file /tmp/tls/server.key --tls-ca-cert-file /tmp/tls/commonair-test-ca.crt --tls-auth-clients no" +
      " --save '' --appendonly no --maxmemory-policy noeviction" +
      ` --user default on ">$VK_DEFAULT" ${rules}` +
      ` --user commonair on ">$VK_ACL" ${rules}` +
      ` --user admin on ">$VK_ADMIN" "~*" "&*" +@all`,
  ].join("\n");
  podmanOk(
    [
      "run",
      "-d",
      "--name",
      VK,
      ...testOwnerArgs(),
      "-e",
      `VK_DEFAULT=${VALKEY_PASSWORD}`,
      "-e",
      `VK_ACL=${ACL_PASSWORD}`,
      "-e",
      `VK_ADMIN=${ADMIN_PASSWORD}`,
      "-v",
      `${certs.dir}:/certs:ro,Z`,
      "-p",
      "127.0.0.1::6380",
      "--entrypoint",
      "sh",
      VALKEY_IMAGE,
      "-c",
      vkStart,
    ],
    { timeoutMs: 300_000 },
  );
  pgPort = hostPort(PG, 5432);
  vkPort = hostPort(VK, 6380);
  const deadline = Date.now() + 120_000;
  // The image's entrypoint runs a socket-only server for init first; wait for the TCP one.
  while (podman(["exec", PG, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).code !== 0) {
    if (Date.now() > deadline) throw new Error(`postgres never started:\n${podman(["logs", PG]).out}`);
    await sleep(500);
  }
  psql(`create role commonair_owner login createrole password '${OWNER_PASSWORD.replaceAll("'", "''")}'`);
  psql("create database commonair owner commonair_owner");
  psql(`create role plain_owner login password '${PLAIN_PASSWORD}'`);
  psql("grant create on database commonair to plain_owner");
  podmanOk([
    "exec",
    "-u",
    "postgres",
    PG,
    "psql",
    "-XqAt",
    "-d",
    "commonair",
    "-c",
    "grant create on schema public to plain_owner",
  ]);
});

afterAll(() => {
  if (!HAVE_PODMAN) return;
  podman(["rm", "-f", "-t", "0", PG, VK]);
  certs?.cleanup();
});

const errors = (f: { level: string; message: string }[]) => f.filter((x) => x.level === "error").map((x) => x.message);

describe.skipIf(!HAVE_PODMAN)("postgres preflight", () => {
  test("a CREATEROLE owner over verified TLS passes, and the budget fits a small pool", async () => {
    const r = await checkPostgres(
      input({ pgUrl: pgUrl("commonair_owner", OWNER_PASSWORD), pgCa: certs.ca, poolMax: 3 }),
    );
    expect(errors(r.findings)).toEqual([]);
    const text = r.findings.map((f) => f.message).join("\n");
    expect(text).toContain("TLS verified (CN=localhost)");
    expect(text).toMatch(/PostgreSQL 17\./);
    expect(text).toContain("commonair_owner has CREATEROLE and is not a superuser");
    // 25 - 3 superuser-reserved = 22; 3 × 5 + 1 + 3 = 19 fits (4 × 5 + 4 = 24 would not).
    expect(r.status).toMatch(/^reachable, TLS verified, PostgreSQL 17\.\S+, \d+\/22 connections in use/);
  });

  test("the default pool of 10 does not fit 22 connections: both numbers and the fix", async () => {
    const r = await checkPostgres(input({ pgUrl: pgUrl("commonair_owner", OWNER_PASSWORD), pgCa: certs.ca }));
    const budget = r.findings.find((f) => f.message.includes("max_connections"));
    expect(budget?.level).toBe("error");
    expect(budget?.message).toContain("54 connections needed");
    expect(budget?.message).toContain("the server allows 22");
    expect(budget?.fix).toContain("DATABASE_POOL_MAX=3");
  });

  test("a wrong CA fails naming the server certificate's subject and issuer", async () => {
    const r = await checkPostgres(input({ pgUrl: pgUrl("commonair_owner", OWNER_PASSWORD), pgCa: certs.otherCa }));
    expect(errors(r.findings)).toHaveLength(1);
    expect(errors(r.findings)[0]).toContain("subject CN=localhost; issuer CN=commonair-test-ca");
    expect(r.findings.at(-1)?.fix).toContain("--database-ca");
  });

  test("the system store does not know a private CA", async () => {
    const r = await checkPostgres(input({ pgUrl: pgUrl("commonair_owner", OWNER_PASSWORD) }));
    expect(errors(r.findings)[0]).toContain("does not verify against the system's trusted CAs");
  });

  test("a role without CREATEROLE: the ALTER ROLE to ask for", async () => {
    const r = await checkPostgres(input({ pgUrl: pgUrl("plain_owner", PLAIN_PASSWORD), pgCa: certs.ca, poolMax: 3 }));
    const f = r.findings.find((x) => x.message.includes("lacks CREATEROLE"));
    expect(f?.level).toBe("error");
    expect(f?.fix).toBe('ask your provider (or a superuser) for: ALTER ROLE "plain_owner" CREATEROLE;');
  });

  test("sslmode=require is refused without --allow-insecure-database, warned with it", async () => {
    const url = pgUrl("commonair_owner", OWNER_PASSWORD, "commonair", "require");
    const refused = await checkPostgres(input({ pgUrl: url }));
    expect(errors(refused.findings)[0]).toContain("sslmode=require, which does not verify the server");
    const allowed = await checkPostgres(input({ pgUrl: url, allowInsecureDatabase: true, poolMax: 3 }));
    expect(errors(allowed.findings)).toEqual([]);
    expect(allowed.findings[0]).toMatchObject({ level: "warning" });
  });

  test("a wrong password names the user, never the password", async () => {
    const r = await checkPostgres(input({ pgUrl: pgUrl("commonair_owner", "not-the-password"), pgCa: certs.ca }));
    const msg = errors(r.findings).join("\n");
    expect(msg).toContain("commonair_owner@localhost");
    expect(msg).not.toContain("not-the-password");
  });
});

describe.skipIf(!HAVE_PODMAN)("valkey preflight", () => {
  const url = (user: string, password: string) =>
    `rediss://${user}:${encodeURIComponent(password)}@localhost:${vkPort}`;

  test("the password-only default user (DigitalOcean's model) passes over verified TLS", async () => {
    const r = await checkValkey(input({ valkeyUrl: url("", VALKEY_PASSWORD), valkeyCa: certs.ca }));
    expect(errors(r.findings)).toEqual([]);
    expect(r.findings.map((f) => f.message)).toContain("valkey: maxmemory-policy noeviction");
    expect(r.status).toMatch(/^reachable, TLS verified, PING ok \(localhost:\d+, \d+ ms\)$/);
  });

  test("an ACL user without @admin and @dangerous (but with INFO) passes", async () => {
    const r = await checkValkey(input({ valkeyUrl: url("commonair", ACL_PASSWORD), valkeyCa: certs.ca }));
    expect(errors(r.findings)).toEqual([]);
  });

  test("a wrong password and a wrong CA fail without printing the password", async () => {
    const bad = await checkValkey(input({ valkeyUrl: url("", "wrong-password"), valkeyCa: certs.ca }));
    expect(errors(bad.findings)[0]).toContain("refused the password");
    expect(JSON.stringify(bad)).not.toContain("wrong-password");
    const ca = await checkValkey(input({ valkeyUrl: url("", VALKEY_PASSWORD), valkeyCa: certs.otherCa }));
    expect(errors(ca.findings)[0]).toContain("subject CN=localhost");
  });

  test("eviction on is refused: BullMQ needs noeviction", async () => {
    const admin = ["exec", VK, "valkey-cli", "--tls", "--cacert", "/tmp/tls/commonair-test-ca.crt", "-p", "6380"];
    const set = (p: string) =>
      podmanOk([
        ...admin,
        "--user",
        "admin",
        "--pass",
        ADMIN_PASSWORD,
        "--no-auth-warning",
        "config",
        "set",
        "maxmemory-policy",
        p,
      ]);
    set("allkeys-lru");
    try {
      const r = await checkValkey(input({ valkeyUrl: url("", VALKEY_PASSWORD), valkeyCa: certs.ca }));
      expect(errors(r.findings)[0]).toContain("maxmemory-policy is allkeys-lru");
    } finally {
      set("noeviction");
    }
  });

  test("the instance's users cannot run CONFIG or ACL (what the e2e proves BullMQ never needs)", () => {
    const cli = [
      "exec",
      VK,
      "valkey-cli",
      "--tls",
      "--cacert",
      "/tmp/tls/commonair-test-ca.crt",
      "-p",
      "6380",
      "--no-auth-warning",
    ];
    expect(podmanOk([...cli, "-a", VALKEY_PASSWORD, "config", "get", "maxmemory"])).toContain("NOPERM");
    expect(podmanOk([...cli, "--user", "commonair", "--pass", ACL_PASSWORD, "acl", "list"])).toContain("NOPERM");
  });
});

describe.skipIf(!HAVE_PODMAN)("the command line", () => {
  test("preflight prints ok lines, exits 0, and never prints a password", () => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, "preflight"], {
      env: {
        PATH: process.env.PATH ?? "",
        STATE_PG_URL: pgUrl("commonair_owner", OWNER_PASSWORD),
        STATE_PG_CA: certs.ca,
        STATE_VALKEY_URL: `rediss://:${VALKEY_PASSWORD}@localhost:${vkPort}`,
        STATE_VALKEY_CA: certs.ca,
        STATE_POOL_MAX: "3",
      },
    });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(r.exitCode, out).toBe(0);
    expect(out).toMatch(/^ok: postgres: TLS verified/m);
    expect(out).toMatch(/^ok: valkey: PING over TLS verified/m);
    for (const secret of [OWNER_PASSWORD, encodeURIComponent(OWNER_PASSWORD), VALKEY_PASSWORD])
      expect(out).not.toContain(secret);
  });

  test("status prints one line per service with its time", () => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, "status"], {
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: pgUrl("commonair_owner", OWNER_PASSWORD),
        STATE_PG_CA: certs.ca,
        VALKEY_URL: `rediss://:${VALKEY_PASSWORD}@localhost:${vkPort}`,
        STATE_VALKEY_CA: certs.ca,
      },
    });
    const lines = r.stdout.toString().trim().split("\n");
    expect(r.exitCode).toBe(0);
    expect(lines[0]).toMatch(
      /^postgres {2}reachable, TLS verified, PostgreSQL 17\.\S+, \d+\/22 connections in use \(commonair_owner@localhost:\d+\/commonair, \d+ ms\)$/,
    );
    expect(lines[1]).toMatch(/^valkey {4}reachable, TLS verified, PING ok \(localhost:\d+, \d+ ms\)$/);
  });
});
