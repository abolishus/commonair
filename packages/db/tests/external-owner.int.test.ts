// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * S1-d (ADR 0032 §3 and §4, contract step §1): the whole database path on a Postgres with no
 * superuser, the way a managed provider (DigitalOcean's `doadmin`) hands it out.
 *
 * A throwaway container of the Postgres image the stack pins runs with TLS only
 * (`ssl_min_protocol_version = TLSv1.2`, `hostssl` lines only in pg_hba) and a CA and server
 * certificate this test makes. The provider's side (the container's superuser) creates only
 * `commonair_owner` (LOGIN CREATEROLE, nothing else) and a database it owns. Everything after
 * that runs as the owner over `sslmode=verify-full` with `DATABASE_CA_FILE`'s path:
 *
 *   - migrate.ts (every migration in packages/drizzle), then apply-app-role.ts with the
 *     monitor role;
 *   - every protection trigger exists exactly as on the superuser-migrated test database and
 *     fires (one probe per family, plus every no-truncate trigger);
 *   - the app role's limits (ADR 0004); the monitor role with and without pg_monitor;
 *   - the owner-only restore of a dump of the seeded database into a fresh database:
 *       1. pg_restore --section=pre-data --no-owner
 *       2. infra/postgres/restore-owner.sql, commonair.restore_triggers=disable
 *       3. pg_restore --section=data
 *       4. infra/postgres/restore-owner.sql, commonair.restore_triggers=enable
 *       5. pg_restore --section=post-data
 *     then apply-app-role.ts and infra/postgres/restore-check.sql against the source.
 *
 * pg_dump and pg_restore run inside the container as the owner (no host client needed). Needs
 * podman; CI's integration job has it, so the test refuses to skip there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { applyAppRole, type ApplyRolesResult } from "../../../infra/postgres/apply-app-role.ts";
import { createDb, type DbHandle, postgresTls } from "../src/client.ts";
import { seedDemo } from "../src/demo/seed.ts";
import { uuidv7 } from "../src/ids.ts";
import { MIGRATIONS_DIR, runMigrations } from "../src/migrate.ts";
import { TEST_APP_ROLE, createTestDatabase } from "../src/testing.ts";
import {
  POSTGRES_IMAGE,
  type TestCerts,
  hostPort,
  makeTestCerts,
  podman,
  podmanAvailable,
  podmanOk,
} from "./external-owner-tls.ts";
import { testOwnerArgs } from "../../../scripts/test-owner.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 900_000 });

const HAVE_PODMAN = podmanAvailable();
if (!HAVE_PODMAN) {
  // A skipped S1-d test would hide the launch-critical check (contract step §5), so CI fails.
  if (process.env.CI) throw new Error("external-owner.int.test.ts needs podman, and CI must run it");
  console.warn("\n*** external-owner.int.test.ts SKIPPED: podman is not available here ***\n");
}

const POSTGRES_DIR = new URL("../../../infra/postgres/", import.meta.url).pathname;
const RESTORE_OWNER_SQL = readFileSync(join(POSTGRES_DIR, "restore-owner.sql"));
const RESTORE_CHECK_SQL = readFileSync(join(POSTGRES_DIR, "restore-check.sql"), "utf8");

const SUFFIX = crypto.randomUUID().slice(0, 8);
const CONTAINER = `commonair-s1d-${SUFFIX}`;
const SUPER_PASSWORD = `super-${crypto.randomUUID()}`;
const OWNER_PASSWORD = `owner-${crypto.randomUUID()}`;
const APP_PASSWORD = `app-${crypto.randomUUID()}`;
const MONITOR_PASSWORD = `monitor-${crypto.randomUUID()}`;
const OWNER = "commonair_owner";
const DB = "commonair";
const RESTORED = "commonair_restored";

// Hostname, not 127.0.0.1: verify-full checks it against the certificate's DNS name.
const PG_HBA = [
  "local all all trust",
  "hostssl all all 0.0.0.0/0 scram-sha-256",
  "hostssl all all ::/0 scram-sha-256",
  "",
].join("\n");

let certs: TestCerts;
let port = 0;
let owner: DbHandle;
let app: DbHandle;
let monitor: DbHandle;
let ownerRoles: ApplyRolesResult;
const handles: DbHandle[] = [];

const url = (user: string, password: string, db = DB, sslmode = "verify-full") =>
  `postgres://${user}:${encodeURIComponent(password)}@localhost:${port}/${db}?sslmode=${sslmode}`;
const ownerUrl = (db = DB) => url(OWNER, OWNER_PASSWORD, db);
function connect(u: string, max = 2): DbHandle {
  const h = createDb({ url: u, max, applicationName: "commonair-s1d", caFile: certs.ca });
  handles.push(h);
  return h;
}

/** psql inside the container over its socket (trust), as `user`. */
function psql(user: string, db: string, sql: string): string {
  return podmanOk([
    "exec",
    "-u",
    "postgres",
    CONTAINER,
    "psql",
    "-XqAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    user,
    "-d",
    db,
    "-c",
    sql,
  ]);
}
function restoreTriggers(user: string, db: string, mode: "disable" | "enable") {
  return podman(
    [
      "exec",
      "-i",
      "-u",
      "postgres",
      "-e",
      `PGOPTIONS=-c commonair.restore_triggers=${mode}`,
      CONTAINER,
      "psql",
      "-Xq",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      user,
      "-d",
      db,
      "-f",
      "-",
    ],
    { stdin: RESTORE_OWNER_SQL },
  );
}
function pgRestore(section: "pre-data" | "data" | "post-data") {
  podmanOk(
    [
      "exec",
      "-u",
      "postgres",
      CONTAINER,
      "pg_restore",
      "--exit-on-error",
      "--no-owner",
      `--section=${section}`,
      "-U",
      OWNER,
      "-d",
      RESTORED,
      "/tmp/commonair.dump",
    ],
    { timeoutMs: 300_000 },
  );
}

/** The database's own message from a refused statement. */
async function refusal(p: PromiseLike<unknown>): Promise<string> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to refuse").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  return e.cause?.message ?? e.message;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForTls(): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = "";
  while (Date.now() < deadline) {
    // The image's entrypoint runs a socket-only server for init first; wait for the real one.
    if (podman(["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).code === 0) {
      const probe = createDb({ url: ownerUrl("postgres"), max: 1, caFile: certs.ca, connectTimeoutSeconds: 5 });
      try {
        await probe.sql`select 1`;
        return;
      } catch (e) {
        last = (e as Error).message;
      } finally {
        await probe.close();
      }
    }
    await sleep(500);
  }
  throw new Error(`the TLS Postgres never accepted the owner: ${last}\n${podman(["logs", CONTAINER]).out}`);
}

/** Triggers, functions and the app role's privileges: what must not differ from the reference. */
async function schemaFacts(h: DbHandle, appRole: string) {
  const triggers = await h.sql<{ fact: string }[]>`
    select c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid) as fact
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = 'public' order by 1`;
  const functions = await h.sql<{ fact: string }[]>`
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') secdef=' || p.prosecdef
           || ' config=' || coalesce(array_to_string(p.proconfig, ','), '') || ' src=' || md5(p.prosrc) as fact
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`;
  const privileges = await h.sql<{ fact: string }[]>`
    select c.relname || ' ' || p.priv as fact
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
      and (has_table_privilege(${appRole}, c.oid, p.priv)
           or (p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege(${appRole}, c.oid, p.priv)))
    order by 1`;
  return {
    triggers: triggers.map((r) => r.fact),
    functions: functions.map((r) => r.fact),
    privileges: privileges.map((r) => r.fact),
  };
}

async function checkCounts(h: DbHandle): Promise<Map<string, string>> {
  const rows = await h.sql.unsafe<{ check_name: string; value: string }[]>(RESTORE_CHECK_SQL);
  return new Map(rows.map((r) => [r.check_name, String(r.value)]));
}

beforeAll(async () => {
  if (!HAVE_PODMAN) return;
  certs = makeTestCerts();
  await Bun.write(join(certs.dir, "pg_hba.conf"), PG_HBA);
  const start = [
    "set -eu",
    "install -d -o postgres -g postgres -m 0700 /etc/pgtls",
    "install -o postgres -g postgres -m 0600 /certs/server.key /etc/pgtls/server.key",
    "install -o postgres -g postgres -m 0644 /certs/server.crt /certs/pg_hba.conf /etc/pgtls/",
    "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/pgtls/server.crt" +
      " -c ssl_key_file=/etc/pgtls/server.key -c ssl_min_protocol_version=TLSv1.2 -c hba_file=/etc/pgtls/pg_hba.conf",
  ].join("\n");
  podmanOk(
    [
      "run",
      "-d",
      "--name",
      CONTAINER,
      ...testOwnerArgs(),
      "-e",
      `POSTGRES_PASSWORD=${SUPER_PASSWORD}`,
      "-v",
      `${certs.dir}:/certs:ro,Z`,
      "-p",
      "127.0.0.1::5432",
      "--entrypoint",
      "sh",
      POSTGRES_IMAGE,
      "-c",
      start,
    ],
    { timeoutMs: 600_000 },
  );
  port = hostPort(CONTAINER, 5432);
  // The provider's side: an owner with CREATEROLE and LOGIN only, and a database it owns.
  const deadline = Date.now() + 120_000;
  while (podman(["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).code !== 0) {
    if (Date.now() > deadline) throw new Error(`postgres never started:\n${podman(["logs", CONTAINER]).out}`);
    await sleep(500);
  }
  psql("postgres", "postgres", `create role ${OWNER} login createrole password '${OWNER_PASSWORD}'`);
  psql("postgres", "postgres", `create database ${DB} owner ${OWNER}`);
  await waitForTls();

  // Everything from here on runs as the owner, over verified TLS.
  await runMigrations(ownerUrl(), { caFile: certs.ca });
  ownerRoles = await applyAppRole(ownerUrl(), APP_PASSWORD, { monitorPassword: MONITOR_PASSWORD, caFile: certs.ca });
  owner = connect(ownerUrl());
  app = connect(url("commonair_app", APP_PASSWORD));
  monitor = connect(url("commonair_monitor", MONITOR_PASSWORD), 1);

  // Seed it as the app role: demo users, channels, follows and audit rows, plus ledger postings
  // in two currencies, so the restore has every kind of row the drill counts.
  const seeded = await seedDemo(app.db, { password: "s1d-demo-password-1" });
  if (seeded.status !== "seeded") throw new Error(`the demo seed did not run: ${seeded.status}`);
  for (const currency of ["usd", "eur"]) {
    await app.sql.begin(async (tx) => {
      const cash = uuidv7();
      const revenue = uuidv7();
      await tx`insert into ledger_accounts (id, code, type, name, currency) values
        (${cash}, ${`asset:s1d-cash-${currency}`}, 'asset', 'cash', ${currency}),
        (${revenue}, ${`revenue:s1d-${currency}`}, 'revenue', 'revenue', ${currency})`;
      const txId = uuidv7();
      await tx`insert into ledger_transactions (id, kind, description, occurred_at, idempotency_key)
        values (${txId}, 'test', 's1d', now(), ${uuidv7()})`;
      await tx`insert into ledger_entries (id, transaction_id, account_id, amount_cents, currency) values
        (${uuidv7()}, ${txId}, ${cash}, 1250, ${currency}), (${uuidv7()}, ${txId}, ${revenue}, -1250, ${currency})`;
    });
  }
});

afterAll(async () => {
  await Promise.allSettled(handles.map((h) => h.close()));
  if (!HAVE_PODMAN) return;
  podman(["rm", "-f", "-t", "0", CONTAINER]);
  certs?.cleanup();
});

describe.runIf(HAVE_PODMAN)("the owner has a managed provider's rights, no more", () => {
  test("it is not a superuser", async () => {
    const [r] = await owner.sql<{ rolsuper: boolean }[]>`select rolsuper from pg_roles where rolname = current_user`;
    expect(r?.rolsuper).toBe(false);
  });

  test("it has CREATEROLE", async () => {
    const [r] = await owner.sql<{ rolcreaterole: boolean }[]>`
      select rolcreaterole from pg_roles where rolname = current_user`;
    expect(r?.rolcreaterole).toBe(true);
  });

  test("it is not a member of pg_monitor with admin option", async () => {
    const rows = await owner.sql`
      select 1 from pg_auth_members m
      where m.roleid = 'pg_monitor'::regrole and m.member = current_user::regrole and m.admin_option`;
    expect(rows).toHaveLength(0);
  });
});

describe.runIf(HAVE_PODMAN)("TLS with a private CA", () => {
  test("connections are TLS 1.2 or later, and the server refuses older", async () => {
    const [r] = await owner.sql<{ ssl: boolean; version: string }[]>`
      select ssl, version from pg_stat_ssl where pid = pg_backend_pid()`;
    expect(r?.ssl).toBe(true);
    expect(["TLSv1.2", "TLSv1.3"]).toContain(r?.version);
    // Only a superuser may read it (the provider's side).
    expect(psql("postgres", "postgres", "show ssl_min_protocol_version").trim()).toBe("TLSv1.2");
  });

  test("sslmode=disable is refused by the server (hostssl only)", async () => {
    const plain = createDb({ url: url(OWNER, OWNER_PASSWORD, DB, "disable"), max: 1, caFile: null });
    try {
      expect(await refusal(plain.sql`select 1`)).toMatch(/no pg_hba\.conf entry|no encryption/);
    } finally {
      await plain.close();
    }
  });

  test("with the CA set, a URL weaker than verify-full is refused before connecting", () => {
    for (const mode of ["disable", "require", "verify-ca"]) {
      expect(() => createDb({ url: url(OWNER, OWNER_PASSWORD, DB, mode), caFile: certs.ca })).toThrow(
        /must say sslmode=verify-full/,
      );
    }
  });

  test("a server certificate from another CA is refused", async () => {
    const wrong = createDb({ url: ownerUrl(), max: 1, caFile: certs.otherCa, connectTimeoutSeconds: 5 });
    try {
      expect(await refusal(wrong.sql`select 1`)).toMatch(/certificate|self.signed|verify/i);
    } finally {
      await wrong.close();
    }
  });

  test("libpq's sslrootcert in the URL works as the CA", async () => {
    const tls = postgresTls(`${ownerUrl()}&sslrootcert=${encodeURIComponent(certs.ca)}`);
    expect(tls.url).not.toContain("sslrootcert");
    const h = createDb({ url: `${ownerUrl()}&sslrootcert=${encodeURIComponent(certs.ca)}`, max: 1, caFile: null });
    try {
      const [r] = await h.sql<{ ok: number }[]>`select 1 as ok`;
      expect(r?.ok).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe.runIf(HAVE_PODMAN)("migrations and the protections, applied by the owner", () => {
  test("every committed migration is applied", async () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
      entries: unknown[];
    };
    const [r] = await owner.sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(r?.n).toBe(journal.entries.length);
  });

  test("triggers, functions and app grants equal the superuser-migrated test database's", async () => {
    // The reference: the same migrations applied by a superuser (createTestDatabase). Every trigger
    // of every migration, 0049 included once it lands, is compared here by name and definition.
    const ref = await createTestDatabase();
    try {
      const want = await schemaFacts(ref, TEST_APP_ROLE);
      const got = await schemaFacts(owner, "commonair_app");
      expect(got.triggers).toEqual(want.triggers);
      expect(got.functions).toEqual(want.functions);
      expect(got.privileges).toEqual(want.privileges);
      expect(got.triggers.length).toBeGreaterThan(50);
    } finally {
      await ref.drop();
    }
  });

  test("every protection trigger is enabled", async () => {
    const off = await owner.sql`
      select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname = 'public' and t.tgenabled <> 'O'`;
    expect(off).toEqual([]);
  });

  // One probe per trigger family, run as the role it guards against. Part (B)'s 0049 adds its
  // probes to B8_PROBES below.
  interface Probe {
    family: string;
    as: "app" | "owner";
    run: (h: DbHandle) => Promise<unknown>;
    refused: RegExp;
  }
  const PROBES: Probe[] = [
    {
      family: "ledger (0001): an unbalanced transaction",
      as: "app",
      run: (h) =>
        h.sql.begin(async (tx) => {
          const [a] = await tx<{ id: string }[]>`select id from ledger_accounts where code = 'asset:s1d-cash-usd'`;
          const [b] = await tx<{ id: string }[]>`select id from ledger_accounts where code = 'revenue:s1d-usd'`;
          const id = uuidv7();
          await tx`insert into ledger_transactions (id, kind, description, occurred_at, idempotency_key)
            values (${id}, 'test', 's1d', now(), ${uuidv7()})`;
          await tx`insert into ledger_entries (id, transaction_id, account_id, amount_cents, currency) values
            (${uuidv7()}, ${id}, ${a?.id ?? ""}, 500, 'usd'), (${uuidv7()}, ${id}, ${b?.id ?? ""}, -499, 'usd')`;
        }),
      refused: /unbalanced/,
    },
    {
      family: "audit (0001): audit_log is append-only, even for the owner",
      as: "owner",
      run: (h) => h.sql`update audit_log set reason = 'rewritten'`,
      refused: /append-only/,
    },
    {
      family: "governance (0001/0002): a setting changes only through a passed proposal",
      as: "app",
      run: (h) =>
        h.sql`update governance_settings set value = '{"streamerShare":0,"coopShare":1}' where key = 'platform.cut'`,
      refused: /passed proposal/,
    },
    {
      family: "batch 6 (0043): a broadcast's kind never changes",
      as: "app",
      run: (h) =>
        h.sql`update broadcasts set kind = case kind when 'live' then 'rehearsal' else 'live' end::broadcast_kind`,
      refused: /kind never changes/,
    },
    {
      family: "batch 7 (0046): follower counts are kept by the follows trigger",
      as: "app",
      run: (h) => h.sql`update channels set follower_count = follower_count + 1`,
      refused: /kept by the follows trigger/,
    },
  ];
  /** 0049_b8_protections.sql (contract part (B)): one probe per new guard. */
  const B8_PROBES: Probe[] = [];

  test.each([...PROBES, ...B8_PROBES].map((p) => [p.family, p] as const))("%s", async (_name, p) => {
    expect(await refusal(p.run(p.as === "app" ? app : owner))).toMatch(p.refused);
  });

  test("the probes found rows to refuse (the seed reached every probed table)", async () => {
    const [r] = await owner.sql<{ audit: number; broadcasts: number; channels: number }[]>`
      select (select count(*) from audit_log)::int as audit, (select count(*) from broadcasts)::int as broadcasts,
             (select count(*) from channels)::int as channels`;
    expect(r?.audit).toBeGreaterThan(0);
    expect(r?.broadcasts).toBeGreaterThan(0);
    expect(r?.channels).toBeGreaterThan(0);
  });

  test("every no-truncate trigger fires for the owner (0049's included, by table)", async () => {
    const tables = await owner.sql<{ relname: string }[]>`
      select distinct c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname = 'public' and t.tgname like '%no_truncate' order by 1`;
    expect(tables.length).toBeGreaterThan(20);
    for (const { relname } of tables) {
      // Names come from the catalog; quoted as identifiers all the same.
      const msg = await refusal(
        owner.sql.begin((tx) => tx.unsafe(`truncate public."${relname.replaceAll('"', '""')}" cascade`)),
      );
      expect(msg, relname).toMatch(/append-only/);
    }
  });
});

describe.runIf(HAVE_PODMAN)("the app role has no rights outside its grants (ADR 0004)", () => {
  test("it cannot create in public", async () => {
    expect(await refusal(app.sql`create table public.s1d_probe (i int)`)).toMatch(/permission denied/);
  });

  test("it cannot create temporary tables", async () => {
    expect(await refusal(app.sql`create temp table s1d_probe (i int)`)).toMatch(/permission denied/);
  });

  test("no attributes, memberships, ownership, database or schema rights beyond its grants", async () => {
    const [r] = await owner.sql<Record<string, boolean | number>[]>`
      select r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication, r.rolinherit,
             (select count(*) from pg_auth_members m where m.member = r.oid)::int as memberships,
             (select count(*) from pg_class c where c.relowner = r.oid)::int as owned,
             has_database_privilege(r.oid, current_database(), 'CREATE') as db_create,
             has_database_privilege(r.oid, current_database(), 'TEMPORARY') as db_temp,
             has_schema_privilege(r.oid, 'public', 'CREATE') as public_create,
             has_schema_privilege(r.oid, 'drizzle', 'USAGE') as drizzle_usage
      from pg_roles r where r.rolname = 'commonair_app'`;
    expect(r).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      rolreplication: false,
      rolinherit: false,
      memberships: 0,
      owned: 0,
      db_create: false,
      db_temp: false,
      public_create: false,
      drizzle_usage: false,
    });
  });
});

describe.runIf(HAVE_PODMAN)("the monitor role", () => {
  // Read by the collector's postgresql receiver with or without pg_monitor (L1-observability).
  const ALWAYS = [
    "select count(*) from pg_stat_database",
    "select count(*) from pg_stat_user_tables",
    "select count(*) from pg_statio_user_tables",
    "select count(*) from pg_stat_user_indexes",
    "select * from pg_stat_bgwriter",
    "select * from pg_stat_checkpointer",
    "select * from pg_stat_wal",
    "select count(*) from pg_locks",
    "select count(*) from pg_stat_replication",
    "select pg_database_size(current_database())",
    "select sum(pg_relation_size(relid)) from pg_stat_user_tables",
    "select setting from pg_settings where name = 'max_connections'",
  ];
  const otherSessionStates = async () => {
    const [r] = await monitor.sql<{ n: number }[]>`
      select count(*) filter (where state is not null)::int as n from pg_stat_activity where usename = ${OWNER}`;
    return r?.n ?? 0;
  };

  test("the owner cannot grant pg_monitor, and the role is created anyway", () => {
    expect(ownerRoles.monitor).toBe("not-grantable");
  });

  test("without pg_monitor it reads the statistics the receiver needs", async () => {
    await owner.sql`select 1`; // keeps an owner session open for the activity check below
    for (const q of ALWAYS) await expect(monitor.sql.unsafe(q), q).resolves.toBeDefined();
    const [t] = await monitor.sql<{ n: number }[]>`select count(*)::int as n from pg_stat_user_tables`;
    expect(t?.n).toBeGreaterThan(50);
  });

  test("without pg_monitor it misses WAL files and other roles' activity (ADR 0032 §4)", async () => {
    expect(await refusal(monitor.sql`select count(*) from pg_ls_waldir()`)).toMatch(/permission denied/);
    expect(await otherSessionStates()).toBe(0);
  });

  test("it reads no application data and never writes", async () => {
    expect(await refusal(monitor.sql`select 1 from public.users limit 1`)).toMatch(/permission denied/);
    const [r] = await monitor.sql<{ default_transaction_read_only: string }[]>`show default_transaction_read_only`;
    expect(r?.default_transaction_read_only).toBe("on");
  });

  test("applied by a superuser (the bundled stack), it gets pg_monitor and sees the rest", async () => {
    const roles = await applyAppRole(url("postgres", SUPER_PASSWORD), APP_PASSWORD, {
      monitorPassword: MONITOR_PASSWORD,
      caFile: certs.ca,
    });
    expect(roles.monitor).toBe("granted");
    const fresh = connect(url("commonair_monitor", MONITOR_PASSWORD), 1);
    await owner.sql`select 1`;
    const [w] = await fresh.sql<{ n: number }[]>`select count(*)::int as n from pg_ls_waldir()`;
    expect(w?.n).toBeGreaterThan(0);
    const [a] = await fresh.sql<{ n: number }[]>`
      select count(*) filter (where state is not null)::int as n from pg_stat_activity where usename = ${OWNER}`;
    expect(a?.n).toBeGreaterThan(0);
  });

  test("the owner re-running the migrate job keeps the grant a superuser made", async () => {
    const roles = await applyAppRole(ownerUrl(), APP_PASSWORD, { monitorPassword: MONITOR_PASSWORD, caFile: certs.ca });
    expect(roles.monitor).toBe("granted");
  });
});

describe.runIf(HAVE_PODMAN)("the owner-only restore (ADR 0032 §4)", () => {
  let source: Map<string, string>;
  let restored: DbHandle;
  let triggersAfterPreData = -1;

  beforeAll(async () => {
    if (!HAVE_PODMAN) return;
    source = await checkCounts(owner);
    podmanOk(
      ["exec", "-u", "postgres", CONTAINER, "pg_dump", "-Fc", "-U", OWNER, "-d", DB, "-f", "/tmp/commonair.dump"],
      {
        timeoutMs: 300_000,
      },
    );
    // The provider's side again: a fresh database the owner owns (doadmin may create it itself).
    psql("postgres", "postgres", `create database ${RESTORED} owner ${OWNER}`);
    pgRestore("pre-data");
    triggersAfterPreData = Number(
      psql(
        OWNER,
        RESTORED,
        "select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal",
      ),
    );
    const off = restoreTriggers(OWNER, RESTORED, "disable");
    if (off.code !== 0) throw new Error(`restore-owner.sql (disable) failed:\n${off.out}`);
    pgRestore("data");
    const on = restoreTriggers(OWNER, RESTORED, "enable");
    if (on.code !== 0) throw new Error(`restore-owner.sql (enable) failed:\n${on.out}`);
    pgRestore("post-data");
    await applyAppRole(ownerUrl(RESTORED), APP_PASSWORD, { monitorPassword: MONITOR_PASSWORD, caFile: certs.ca });
    restored = connect(ownerUrl(RESTORED));
  });

  test("pg_dump puts the triggers in post-data, so the data load never meets them", () => {
    expect(triggersAfterPreData).toBe(0);
  });

  test("row counts per table, ledger balance per currency and follower counts match the source", async () => {
    const got = await checkCounts(restored);
    expect(Object.fromEntries(got)).toEqual(Object.fromEntries(source));
    const balances = [...got].filter(([k]) => k.startsWith("ledger.balance."));
    expect(balances.map(([k]) => k).sort()).toEqual(["ledger.balance.eur", "ledger.balance.usd"]);
    for (const [k, v] of balances) expect(v, k).toBe("0");
    expect(got.get("follows.count_mismatch")).toBe("0");
    expect(Number(got.get("rows.public.follows"))).toBeGreaterThan(0);
    expect(Number(got.get("rows.public.ledger_entries"))).toBeGreaterThan(0);
  });

  test("the restored database has every trigger, enabled, and its protections fire for the app role", async () => {
    expect((await schemaFacts(restored, "commonair_app")).triggers).toEqual(
      (await schemaFacts(owner, "commonair_app")).triggers,
    );
    const restoredApp = connect(url("commonair_app", APP_PASSWORD, RESTORED));
    expect(await refusal(restoredApp.sql`update channels set follower_count = follower_count + 1`)).toMatch(
      /kept by the follows trigger/,
    );
  });

  test("a doubled follower_count is caught by the check", async () => {
    // What a data load with the follows trigger on would do: count every follower again.
    await restored.sql`update channels set follower_count = follower_count * 2 where follower_count > 0`;
    const got = await checkCounts(restored);
    expect(Number(got.get("follows.count_mismatch"))).toBeGreaterThan(0);
    expect(got.get("follows.count_mismatch")).not.toBe(source.get("follows.count_mismatch"));
    await restored.sql`update channels set follower_count = follower_count / 2 where follower_count > 0`;
  });

  test("restore-owner.sql switches every user trigger as the owner, and refuses another role", async () => {
    const states = () =>
      psql(
        OWNER,
        RESTORED,
        "select string_agg(distinct t.tgenabled::text, ',') from pg_trigger t where not t.tgisinternal",
      ).trim();
    expect(restoreTriggers(OWNER, RESTORED, "disable").code).toBe(0);
    expect(states()).toBe("D");
    expect(restoreTriggers(OWNER, RESTORED, "enable").code).toBe(0);
    expect(states()).toBe("O");
    const asApp = restoreTriggers("commonair_app", RESTORED, "disable");
    expect(asApp.code).not.toBe(0);
    expect(asApp.out).toMatch(/belongs to commonair_owner/);
  });
});
