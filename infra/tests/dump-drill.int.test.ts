// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The logical dump and its drill (S1-h, ADR 0032 §4) against real Postgres, in the image the
 * stack builds on: infra/postgres/dump.sh dumps a fixture database while rows are being written,
 * dump-drill.sh restores it into a throwaway container through dump-restore.sh (the owner-only
 * order, as an owner with no superuser) and checks the counts against the dump's counts.json.
 *
 * The fixture has what the drill's checks read: channels with a trigger-kept follower_count, a
 * SECURITY DEFINER trigger function revoked from PUBLIC, ledger entries in two currencies,
 * drizzle's migrations table, and a grant to commonair_app. The checks must fail on a doubled
 * follower_count, which is what a data load with the follows trigger on does, on a row count
 * that differs from the dump's, and in a container that is not the drill's (no marker).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { POSTGRES_IMAGE, podman, podmanAvailable, podmanOk } from "../../packages/db/tests/external-owner-tls.ts";
import { testOwnerArgs } from "../../scripts/test-owner.ts";
import { shellcheck } from "../../scripts/tests/support/shellcheck.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const HAVE_PODMAN = podmanAvailable();
if (!HAVE_PODMAN) {
  if (process.env.CI) throw new Error("dump-drill.int.test.ts needs podman, and CI must run it");
  console.warn("\n*** dump-drill.int.test.ts SKIPPED: podman is not available here ***\n");
}

const ROOT = new URL("../../", import.meta.url).pathname;
const SUFFIX = crypto.randomUUID().slice(0, 8);
const SOURCE = `commonair-s1h-source-${SUFFIX}`;
const DRILL = `commonair-s1h-drill-${SUFFIX}`;
const TOKEN = `drill-${crypto.randomUUID()}`;
/** Where the scripts land in each container, as the image's own copies would. */
const S = "/opt/commonair";
const DRILL_ENV = [
  "-e",
  `COMMONAIR_DRILL_TOKEN=${TOKEN}`,
  "-e",
  "PGDATA=/var/lib/postgresql/data/drill",
  "-e",
  `RESTORE_CHECK_SQL=${S}/restore-check.sql`,
  "-e",
  `RESTORE_OWNER_SQL=${S}/restore-owner.sql`,
  "-e",
  `COMMONAIR_DUMP_RESTORE=${S}/dump-restore.sh`,
];
const SCRIPTS = ["dump.sh", "dump-restore.sh", "dump-drill.sh", "restore-owner.sql", "restore-check.sql"];

const FIXTURE = `
CREATE ROLE commonair_app NOLOGIN;
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL);
INSERT INTO drizzle.__drizzle_migrations (hash) VALUES ('0000'), ('0001');
CREATE TABLE public.channels (id int PRIMARY KEY, follower_count int NOT NULL DEFAULT 0);
CREATE TABLE public.follows (
  channel_id int NOT NULL REFERENCES public.channels, user_id int NOT NULL, excluded_at timestamptz,
  PRIMARY KEY (channel_id, user_id)
);
CREATE FUNCTION public.follows_count() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.excluded_at IS NULL THEN
    UPDATE public.channels SET follower_count = follower_count + 1 WHERE id = NEW.channel_id;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.follows_count() FROM PUBLIC;
CREATE TRIGGER follows_count AFTER INSERT ON public.follows FOR EACH ROW EXECUTE FUNCTION public.follows_count();
CREATE TABLE public.ledger_transactions (id int PRIMARY KEY);
CREATE TABLE public.ledger_entries (
  id serial PRIMARY KEY, transaction_id int NOT NULL REFERENCES public.ledger_transactions,
  amount_cents bigint NOT NULL, currency text NOT NULL
);
GRANT SELECT ON ALL TABLES IN SCHEMA public TO commonair_app;
INSERT INTO public.channels (id) SELECT g FROM generate_series(1, 20) g;
INSERT INTO public.follows (channel_id, user_id) SELECT 1 + g % 20, g FROM generate_series(1, 400) g;
INSERT INTO public.follows (channel_id, user_id, excluded_at) VALUES (1, 100000, now());
INSERT INTO public.ledger_transactions VALUES (1), (2);
INSERT INTO public.ledger_entries (transaction_id, amount_cents, currency) VALUES
  (1, 500, 'usd'), (1, -500, 'usd'), (2, 300, 'eur'), (2, -300, 'eur');
`;

const psql = (container: string, user: string, db: string, sql: string) =>
  podmanOk(["exec", container, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", db, "-c", sql]).trim();

function copyScripts(container: string) {
  podmanOk(["exec", "-u", "0", container, "mkdir", "-p", S]);
  for (const f of SCRIPTS) podmanOk(["cp", join(ROOT, "infra/postgres", f), `${container}:${S}/${f}`]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const drill = (args: string[], opts: { stdin?: Uint8Array; env?: string[] } = {}) =>
  podman(["exec", ...(opts.stdin ? ["-i"] : []), ...(opts.env ?? []), DRILL, `${S}/dump-drill.sh`, ...args], {
    stdin: opts.stdin,
    timeoutMs: 300_000,
  });

let work = "";
let dumpFile = "";
let counts = "";

/** A fresh drill database: the restore again, from the same dump. */
function resetDrill() {
  psql(DRILL, "postgres", "postgres", "DROP DATABASE IF EXISTS commonair");
  psql(DRILL, "postgres", "postgres", "DROP ROLE IF EXISTS commonair_drill_owner");
}

beforeAll(async () => {
  if (!HAVE_PODMAN) return;
  work = mkdtempSync(join(tmpdir(), "commonair-s1h-"));
  podmanOk(
    [
      "run",
      "-d",
      ...testOwnerArgs(),
      "--name",
      SOURCE,
      "--network",
      "none",
      "-e",
      "POSTGRES_PASSWORD=unused-local-only",
      POSTGRES_IMAGE,
    ],
    { timeoutMs: 600_000 },
  );
  // The drill container as selfhost.sh starts it: no network, the server on a socket only.
  podmanOk(
    [
      "create",
      ...testOwnerArgs(),
      "--name",
      DRILL,
      "--network",
      "none",
      "--user",
      "postgres",
      ...DRILL_ENV,
      "--entrypoint",
      `${S}/dump-drill.sh`,
      POSTGRES_IMAGE,
      "serve",
    ],
    { timeoutMs: 600_000 },
  );
  // A created container runs nothing to `exec mkdir` in: copy the whole directory, which lands
  // as $S since $S does not exist yet.
  podmanOk(["cp", join(ROOT, "infra/postgres"), `${DRILL}:${S}`]);
  podmanOk(["start", DRILL]);
  // The image's entrypoint runs a socket-only server for init first; wait for the real one.
  await until(
    "the source server",
    () => podman(["exec", SOURCE, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).code === 0,
  );
  copyScripts(SOURCE);
  psql(SOURCE, "postgres", "postgres", "CREATE DATABASE src");
  podmanOk(["exec", "-i", SOURCE, "psql", "-Xq", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "src", "-f", "-"], {
    stdin: new TextEncoder().encode(FIXTURE),
  });
  await until("the drill server", () => drill(["ready"]).code === 0);

  // Writes keep arriving while the dump runs: the counts must still be the dump's own.
  podmanOk([
    "exec",
    "-d",
    SOURCE,
    "sh",
    "-c",
    "i=200000; while [ ! -e /tmp/stop ]; do i=$((i+1)); " +
      'psql -Xq -U postgres -d src -c "INSERT INTO follows (channel_id, user_id) VALUES (1 + $i % 20, $i)" >/dev/null 2>&1; done',
  ]);
  await sleep(1_000);
  const dump = Bun.spawnSync(
    [
      "podman",
      "exec",
      "-e",
      "DUMP_PG_URL=postgresql://postgres@/src?host=/var/run/postgresql",
      "-e",
      "DUMP_COUNTS_OUT=/tmp/out/counts.json",
      "-e",
      `RESTORE_CHECK_SQL=${S}/restore-check.sql`,
      SOURCE,
      `${S}/dump.sh`,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 300_000 },
  );
  podmanOk(["exec", SOURCE, "touch", "/tmp/stop"]);
  if (dump.exitCode !== 0) throw new Error(`dump.sh failed: ${dump.stderr.toString()}`);
  dumpFile = join(work, "commonair.dump");
  writeFileSync(dumpFile, dump.stdout);
  counts = podmanOk(["exec", SOURCE, "cat", "/tmp/out/counts.json"]);
  podmanOk(["cp", dumpFile, `${DRILL}:/var/lib/postgresql/data/commonair.dump`]);
});

afterAll(() => {
  if (!HAVE_PODMAN) return;
  podman(["rm", "-f", "-v", SOURCE, DRILL]);
  if (work) rmSync(work, { recursive: true, force: true });
});

const enc = (s: string) => new TextEncoder().encode(s);
const restore = () => drill(["restore", "/var/lib/postgresql/data/commonair.dump"]);
const check = (json = counts) => drill(["check", "-"], { stdin: enc(json) });

describe.runIf(HAVE_PODMAN)("dump.sh", () => {
  test("writes a custom-format dump to stdout and the counts of its snapshot beside it", () => {
    expect(readFileSync(dumpFile).subarray(0, 5).toString()).toBe("PGDMP");
    expect(counts).toContain('"format": "commonair-dump-counts/1"');
    expect(counts).toMatch(/"rows\.public\.channels": 20,/);
    expect(counts).toMatch(/"rows\.drizzle\.__drizzle_migrations": 2,/);
    expect(counts).toMatch(/"follows\.count_mismatch": 0,/);
    expect(counts).toMatch(/"ledger\.balance\.usd": 0/);
    // The writer added rows before and during the dump.
    const follows = Number(/"rows\.public\.follows": (\d+)/.exec(counts)?.[1]);
    expect(follows).toBeGreaterThan(401);
  });

  test("refuses to write a dump to a terminal and needs the URL from the environment", () => {
    const r = podman(["exec", SOURCE, `${S}/dump.sh`]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("DUMP_PG_URL is not set");
  });
});

describe.runIf(HAVE_PODMAN)("dump-drill.sh restore and check", () => {
  test("the owner-only restore, as an owner with no superuser, matches the dump's counts", () => {
    resetDrill();
    const r = restore();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("5/5 post-data");
    expect(
      psql(
        DRILL,
        "postgres",
        "postgres",
        "SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = 'commonair_drill_owner'",
      ),
    ).toBe("f|t");
    expect(
      psql(
        DRILL,
        "postgres",
        "commonair",
        "SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'follows'",
      ),
    ).toBe("commonair_drill_owner");
    const c = check();
    expect(c.code, c.out).toBe(0);
    expect(c.out).toMatch(/all \d+ checks match/);
    // Privileges came back: the trigger function is still not PUBLIC's, the grant is there.
    expect(
      psql(
        DRILL,
        "postgres",
        "commonair",
        "SELECT has_function_privilege('public', 'public.follows_count()', 'EXECUTE')",
      ),
    ).toBe("f");
    expect(
      psql(DRILL, "postgres", "commonair", "SELECT has_table_privilege('commonair_app', 'public.channels', 'SELECT')"),
    ).toBe("t");
    // Every user trigger is on again after the data load.
    expect(
      psql(
        DRILL,
        "postgres",
        "commonair",
        "SELECT string_agg(DISTINCT tgenabled::text, ',') FROM pg_trigger WHERE NOT tgisinternal",
      ),
    ).toBe("O");
  });

  test("a doubled follower_count fails the check", () => {
    psql(DRILL, "postgres", "commonair", "UPDATE channels SET follower_count = follower_count * 2");
    try {
      const c = check();
      expect(c.code).toBe(1);
      expect(c.out).toMatch(/follows\.count_mismatch: dump 0, restored \d+/);
      expect(c.out).toMatch(/follows\.count_mismatch: \d+, must be 0/);
    } finally {
      psql(DRILL, "postgres", "commonair", "UPDATE channels SET follower_count = follower_count / 2");
    }
  });

  test("a row count that differs from the dump's fails the check", () => {
    const changed = counts.replace(
      /("rows\.public\.ledger_entries": )(\d+)/,
      (_m, k: string, n: string) => `${k}${Number(n) + 1}`,
    );
    expect(changed).not.toBe(counts);
    const c = check(changed);
    expect(c.code).toBe(1);
    expect(c.out).toMatch(/rows\.public\.ledger_entries: dump \d+, restored \d+/);
  });

  test("an unbalanced ledger transaction fails the check", () => {
    psql(DRILL, "postgres", "commonair", "UPDATE ledger_entries SET currency = 'eur' WHERE id = 1");
    try {
      const c = check();
      expect(c.code).toBe(1);
      expect(c.out).toMatch(/ledger\.unbalanced_transactions: \d+, must be 0/);
    } finally {
      psql(DRILL, "postgres", "commonair", "UPDATE ledger_entries SET currency = 'usd' WHERE id = 1");
    }
  });

  test("a data load with the triggers on (the bug the owner-only order avoids) is caught", () => {
    // Tables and triggers first, data after (a data-only load into a migrated schema): every
    // follow is counted a second time.
    resetDrill();
    psql(DRILL, "postgres", "postgres", "CREATE ROLE commonair_drill_owner LOGIN CREATEROLE");
    psql(DRILL, "postgres", "postgres", "CREATE DATABASE commonair OWNER commonair_drill_owner");
    const dump = "/var/lib/postgresql/data/commonair.dump";
    const restoreAs = (args: string) =>
      podmanOk(
        [
          "exec",
          DRILL,
          "sh",
          "-c",
          `pg_restore --exit-on-error --no-owner -U commonair_drill_owner -d commonair ${args} ${dump}`,
        ],
        {
          timeoutMs: 300_000,
        },
      );
    restoreAs("--section=pre-data");
    podmanOk(["exec", DRILL, "sh", "-c", `pg_restore -l ${dump} | grep ' TRIGGER ' > /tmp/triggers.list`]);
    restoreAs("-L /tmp/triggers.list");
    restoreAs("--section=data");
    const c = check();
    expect(c.code).toBe(1);
    expect(c.out).toContain("follows.count_mismatch");
  });

  test("the restore refuses a database that already has tables", () => {
    const r = restore();
    expect(r.code).not.toBe(0);
  });

  test("the output names checks and numbers only, never a row", () => {
    resetDrill();
    expect(restore().code).toBe(0);
    const c = check();
    for (const line of c.out.trim().split("\n"))
      expect(line).toMatch(/^(all \d+ checks match|  [a-z_.]+: .*|\d+ of the checks failed.*)$/);
  });
});

describe.runIf(HAVE_PODMAN)("the drill's target guard", () => {
  test("a container that is not the drill's is refused: no marker, no token", () => {
    // A file argument, not stdin: the guard refuses before reading anything.
    const r = podman(["exec", SOURCE, `${S}/dump-drill.sh`, "check", "/nonexistent.json"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("COMMONAIR_DRILL_TOKEN is not set");
    const withToken = podman([
      "exec",
      "-e",
      `COMMONAIR_DRILL_TOKEN=${TOKEN}`,
      SOURCE,
      `${S}/dump-drill.sh`,
      "check",
      "/nonexistent.json",
    ]);
    expect(withToken.code).toBe(2);
    expect(withToken.out).toContain("no commonair-drill.token");
  });

  test("a wrong token is refused", () => {
    const r = drill(["check", "/nonexistent.json"], { env: ["-e", "COMMONAIR_DRILL_TOKEN=someone-else"] });
    expect(r.code).toBe(2);
    expect(r.out).toContain("does not hold this drill's token");
  });

  test.each([
    ["PGHOST", "db.example.org"],
    ["PGHOSTADDR", "10.0.0.5"],
    ["DATABASE_URL", "postgres://u@db.example.org/commonair"],
    ["PGSERVICE", "live"],
  ])("%s pointing elsewhere is refused before any connection", (name, value) => {
    const r = drill(["check", "/nonexistent.json"], { env: ["-e", `${name}=${value}`] });
    expect(r.code).toBe(2);
    expect(r.out).toContain(name);
  });

  test("the drill's server listens on no TCP port", () => {
    expect(psql(DRILL, "postgres", "postgres", "SHOW listen_addresses")).toBe("");
    expect(podman(["exec", DRILL, "pg_isready", "-h", "127.0.0.1"]).code).not.toBe(0);
  });
});

// check-walg reads no counts.json: only the invariants, as the cluster's superuser, in a server
// that proves it is the drill's. A restored dump stands in for the WAL-G copy here: the mode
// cannot tell them apart, and what is under test is the compare with an empty expected file.
describe.runIf(HAVE_PODMAN)("dump-drill.sh check-walg", () => {
  const checkWalg = () => drill(["check-walg"], { env: ["-e", "POSTGRES_DB=commonair"] });

  test("a consistent CommonAir database passes with no expected counts", () => {
    resetDrill();
    expect(restore().code).toBe(0);
    const c = checkWalg();
    expect(c.code, c.out).toBe(0);
    expect(c.out).toMatch(/all \d+ checks match/);
    expect(c.out).not.toContain("missing after the restore");
  });

  test("a doubled follower_count fails it", () => {
    psql(DRILL, "postgres", "commonair", "UPDATE channels SET follower_count = follower_count * 2");
    try {
      const c = checkWalg();
      expect(c.code).toBe(1);
      expect(c.out).toMatch(/follows\.count_mismatch: \d+, must be 0/);
    } finally {
      psql(DRILL, "postgres", "commonair", "UPDATE channels SET follower_count = follower_count / 2");
    }
  });

  test("a database with no migrations is not a CommonAir one", () => {
    psql(DRILL, "postgres", "commonair", "ALTER TABLE drizzle.__drizzle_migrations RENAME TO m_aside");
    try {
      const c = checkWalg();
      expect(c.code).not.toBe(0);
      expect(c.out).toContain("not a CommonAir database");
    } finally {
      psql(DRILL, "postgres", "commonair", "ALTER TABLE drizzle.m_aside RENAME TO __drizzle_migrations");
    }
  });
});

describe.runIf(HAVE_PODMAN)("shellcheck", () => {
  test.each(["dump.sh", "dump-restore.sh", "dump-drill.sh"])("infra/postgres/%s is clean (POSIX sh)", (f) => {
    const r = shellcheck(join(ROOT, "infra/postgres", f));
    expect(r.code, r.out).toBe(0);
  });
});
