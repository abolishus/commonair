// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Brings up a SEPARATE compose project (`commonair-it-<rand>`, host ports shifted) with
 * the data services and one-shot jobs, and checks what the platform relies on:
 * health, Garage bootstrap, the least-privilege app role, WAL archiving, and a
 * backup → restore round trip. Never touches the shared `commonair` project.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createS3Storage, type ObjectStorage } from "@commonair/storage";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../../", import.meta.url).pathname;
const SUFFIX = crypto.randomUUID().slice(0, 8);
const PROJECT = `commonair-it-${SUFFIX}`;
const OFFSET = 20_000 + Math.floor(Math.random() * 90) * 10;
const SERVICES = ["postgres", "valkey", "garage", "garage-init", "mailpit", "migrate"];
const hex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

const ports = {
  POSTGRES_PORT: 5432 + OFFSET,
  VALKEY_PORT: 6379 + OFFSET,
  GARAGE_S3_PORT: 3900 + OFFSET,
  MAILPIT_SMTP_PORT: 1025 + OFFSET,
  MAILPIT_HTTP_PORT: 8025 + OFFSET,
};
const secrets = {
  POSTGRES_PASSWORD: `owner-${hex(12)}`,
  POSTGRES_APP_PASSWORD: `app-${hex(12)}`,
  GARAGE_RPC_SECRET: hex(32),
  GARAGE_ADMIN_TOKEN: hex(24),
  S3_ACCESS_KEY_ID: `GK${hex(12)}`,
  S3_SECRET_ACCESS_KEY: hex(32),
};
const envDir = mkdtempSync(join(tmpdir(), "commonair-it-"));
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])),
  ...secrets,
  COMMONAIR_ENV_FILE: join(envDir, "it.env"),
  IMAGE_TAG: "it",
  // The shared stack owns the default subnet; podman refuses overlapping networks.
  COMPOSE_SUBNET: `10.89.${100 + (Number.parseInt(SUFFIX.slice(0, 4), 16) % 100)}.0/24`,
  BIND_ADDRESS: "127.0.0.1",
};

// spawnSync blocks the event loop, so vitest's hook timeouts cannot fire: every call needs its own.
function run(cmd: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): { code: number; out: string } {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const p = Bun.spawnSync(cmd, {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const out = `${p.stdout.toString()}${p.stderr.toString()}`;
  if (p.exitedDueToTimeout)
    throw new Error(`${cmd.join(" ")} timed out after ${timeoutMs / 1000}s:\n${out.slice(-4000)}`);
  if (p.exitCode !== 0 && !opts.allowFail)
    throw new Error(`${cmd.join(" ")} failed (${p.exitCode}):\n${out.slice(-4000)}`);
  return { code: p.exitCode ?? -1, out };
}
const compose = (args: string[], timeoutMs?: number) =>
  run(["podman", "compose", "-p", PROJECT, ...args], { timeoutMs });

function container(service: string): string {
  const id = run([
    "podman",
    "ps",
    "-a",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${PROJECT}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ]).out.trim();
  if (!id) throw new Error(`no container for ${service}`);
  return id.split("\n")[0]!;
}
const inspect = (id: string, fmt: string) => run(["podman", "inspect", "-f", fmt, id]).out.trim();

async function until<T>(
  what: string,
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${String(last)}`);
    await Bun.sleep(1000);
  }
}

const ownerUrl = `postgres://commonair:${secrets.POSTGRES_PASSWORD}@127.0.0.1:${ports.POSTGRES_PORT}/commonair`;
const appUrl = `postgres://commonair_app:${secrets.POSTGRES_APP_PASSWORD}@127.0.0.1:${ports.POSTGRES_PORT}/commonair`;
let owner: postgres.Sql;
let app: postgres.Sql;
let s3: ObjectStorage;

beforeAll(async () => {
  run(["bun", "scripts/init-env.ts", "--out", env.COMMONAIR_ENV_FILE!]);
  compose(["up", "-d", "--build", ...SERVICES], 15 * 60_000);
  for (const svc of ["postgres", "valkey", "garage", "mailpit"])
    await until(`${svc} healthy`, () =>
      inspect(container(svc), "{{.State.Health.Status}}") === "healthy" ? true : undefined,
    );
  for (const job of ["garage-init", "migrate"])
    await until(
      `${job} finished`,
      () => {
        const id = container(job);
        if (inspect(id, "{{.State.Status}}") !== "exited") return undefined;
        const code = inspect(id, "{{.State.ExitCode}}");
        if (code !== "0")
          throw new Error(`${job} exited ${code}:\n${run(["podman", "logs", id], { allowFail: true }).out}`);
        return true;
      },
      300_000,
    );
  owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  app = postgres(appUrl, { max: 1, onnotice: () => {} });
  s3 = createS3Storage({
    endpoint: `http://127.0.0.1:${ports.GARAGE_S3_PORT}`,
    region: "garage",
    accessKeyId: secrets.S3_ACCESS_KEY_ID,
    secretAccessKey: secrets.S3_SECRET_ACCESS_KEY,
    forcePathStyle: true,
  });
}, 900_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await app?.end({ timeout: 5 });
  run(["podman", "compose", "-p", PROJECT, "down", "-v", "-t", "5"], { allowFail: true });
  run(["podman", "rm", "-f", `${PROJECT}-restore`], { allowFail: true });
  rmSync(envDir, { recursive: true, force: true });
}, 120_000);

describe("compose data stack", () => {
  test("garage-init created the buckets and the imported key can PUT/GET", async () => {
    for (const bucket of ["commonair-media", "commonair-exports", "commonair-backups"]) {
      const key = `it/${crypto.randomUUID()}.txt`;
      await s3.put(bucket, key, `hello ${bucket}`, { contentType: "text/plain" });
      const res = await s3.get(bucket, key);
      expect(await res?.text()).toBe(`hello ${bucket}`);
      await s3.delete(bucket, key);
      expect(await s3.head(bucket, key)).toBeNull();
    }
  });

  test("garage-init is idempotent", () => {
    const id = container("garage-init");
    const r = run(["podman", "start", "-a", id], { allowFail: true });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("buckets created: none");
  });

  test("the app role can read and write ordinary tables", async () => {
    const [row] = await app`select current_user as u, count(*)::int as n from governance_settings`;
    expect(row?.u).toBe("commonair_app");
    expect(row?.n).toBeGreaterThan(0);
  });

  test("the app role cannot TRUNCATE, create temp tables, write history or do DDL", async () => {
    await expect(app`truncate governance_settings_history`).rejects.toThrow(/permission denied/);
    await expect(app`truncate ledger_entries`).rejects.toThrow(/permission denied/);
    await expect(app`create temp table shadow (id int)`).rejects.toThrow(/permission denied/);
    await expect(app`create table public.evil (id int)`).rejects.toThrow(/permission denied/);
    await expect(app`insert into governance_settings_history (id) values (gen_random_uuid())`).rejects.toThrow(
      /permission denied/,
    );
    await expect(app`delete from governance_settings_history`).rejects.toThrow(/permission denied/);
    const [attrs] = await owner`
      select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
      from pg_roles where rolname = 'commonair_app'`;
    expect(attrs).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      rolreplication: false,
    });
  });

  test("re-running migrate keeps the role working (idempotent)", async () => {
    const id = container("migrate");
    const r = run(["podman", "start", "-a", id], { allowFail: true });
    expect(r.code, r.out).toBe(0);
    const [row] = await app`select 1 as ok`;
    expect(row?.ok).toBe(1);
  });

  test("WAL segments are archived to the backups bucket", async () => {
    await owner`create table if not exists it_wal (id serial primary key, at timestamptz default now())`;
    await owner`insert into it_wal default values`;
    await owner`select pg_switch_wal()`;
    const found = await until(
      "archived WAL",
      async () => {
        for await (const obj of s3.list("commonair-backups", "wal/")) if (obj.key.includes("wal_005")) return obj.key;
        await owner`select pg_switch_wal()`;
        return undefined;
      },
      180_000,
    );
    expect(found).toMatch(/^wal\//);
    const [stats] = await owner`select archived_count::int as n, failed_count::int as f from pg_stat_archiver`;
    expect(stats?.n).toBeGreaterThan(0);
  }, 200_000);

  test("backup.sh pushes a base backup and restore.sh replays it with later WAL", async () => {
    const pg = container("postgres");
    const backup = run(["podman", "exec", pg, "commonair-backup"], { allowFail: true, timeoutMs: 240_000 });
    expect(backup.code, backup.out).toBe(0);
    const marker = `m${SUFFIX}`;
    // Written after the base backup: only WAL replay can bring it back.
    await owner.unsafe(
      `create table it_restore_${marker} (v text); insert into it_restore_${marker} values ('${marker}')`,
    );
    const [{ lsn }] = (await owner`select pg_current_wal_lsn()::text as lsn`) as unknown as [{ lsn: string }];
    await owner`select pg_switch_wal()`;
    await until(
      "marker WAL archived",
      async () => {
        const [s] = await owner`select last_archived_wal from pg_stat_archiver`;
        const [w] = await owner`select pg_walfile_name(${lsn}::pg_lsn) as f`;
        return s?.last_archived_wal && s.last_archived_wal >= w?.f ? true : undefined;
      },
      120_000,
    );
    const image = inspect(pg, "{{.ImageName}}");
    const script = [
      "set -e",
      "commonair-restore /var/lib/postgresql/restore",
      "gosu postgres postgres -D /var/lib/postgresql/restore -c port=5433 -c archive_mode=off -c listen_addresses='' &",
      "for i in $(seq 1 120); do",
      `  if gosu postgres psql -h /var/run/postgresql -p 5433 -U commonair -d commonair -Atc "select pg_is_in_recovery()" 2>/dev/null | grep -qx f; then break; fi`,
      "  sleep 1",
      "done",
      `echo "RESTORED=$(gosu postgres psql -h /var/run/postgresql -p 5433 -U commonair -d commonair -Atc "select v from it_restore_${marker}")"`,
    ].join("\n");
    const r = run(
      [
        "podman",
        "run",
        "--rm",
        "--name",
        `${PROJECT}-restore`,
        "--network",
        `${PROJECT}_default`,
        "-e",
        `S3_ACCESS_KEY_ID=${secrets.S3_ACCESS_KEY_ID}`,
        "-e",
        `S3_SECRET_ACCESS_KEY=${secrets.S3_SECRET_ACCESS_KEY}`,
        "--entrypoint",
        "sh",
        image,
        "-c",
        script,
      ],
      { allowFail: true, timeoutMs: 240_000 },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`RESTORED=${marker}\n`);
  }, 300_000);
});
