// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs commonair-pg-health (infra/postgres/health.sh) in the real postgres image against a
 * server in each state the unit must tell apart: accepting connections (ready), replaying
 * archived WAL slowly but advancing (not ready, never stopped), replay stuck (stopped after
 * the bound), and a server that never comes up on a normal start (stopped after its bound).
 * The bounds are shortened through the script's environment. Needs podman.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../../", import.meta.url).pathname;
const SUFFIX = crypto.randomUUID().slice(0, 8);
const IMAGE = `localhost/commonair/postgres:health-it-${SUFFIX}`;
const VOLUME = `commonair-pgh-${SUFFIX}`;
const name = (role: string) => `commonair-pgh-${role}-${SUFFIX}`;
const SEGMENTS = 8;
const env = ["-e", "POSTGRES_USER=commonair", "-e", "POSTGRES_DB=commonair", "-e", "POSTGRES_PASSWORD=it"];

// spawnSync blocks the event loop, so every call carries its own timeout.
function podman(args: string[], timeoutMs = 120_000): { code: number; out: string } {
  const p = Bun.spawnSync(["podman", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  return { code: p.exitCode ?? -1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}
function ok(args: string[], timeoutMs?: number): string {
  const r = podman(args, timeoutMs);
  if (r.code !== 0) throw new Error(`podman ${args.join(" ")} failed (${r.code}):\n${r.out}`);
  return r.out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = (c: string) => podman(["inspect", c, "--format", "{{.State.Running}}"]).out.trim() === "true";
const health = (c: string, args: string[] = [], extraEnv: string[] = []) =>
  podman(["exec", ...extraEnv, c, "commonair-pg-health", ...args], 30_000);
const psql = (c: string, sql: string) =>
  ok(["exec", "-u", "postgres", c, "psql", "-XqAt", "-U", "commonair", "-d", "commonair", "-c", sql]).trim();

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

/** A recovering server on a base backup at /backup/<dir>, with the given restore_command. */
function startRecovery(role: string, dir: string, restoreCommand: string, extraEnv: string[]): string {
  const pgdata = `/backup/${dir}`;
  ok([
    "run",
    "--rm",
    "-u",
    "postgres",
    "-v",
    `${VOLUME}:/backup`,
    "--entrypoint",
    "sh",
    IMAGE,
    "-c",
    `printf "restore_command = '%s'\\n" "$1" >> ${pgdata}/postgresql.auto.conf && touch ${pgdata}/recovery.signal`,
    "sh",
    restoreCommand,
  ]);
  const c = name(role);
  ok([
    "run",
    "-d",
    "--init",
    "--name",
    c,
    "-v",
    `${VOLUME}:/backup`,
    "-e",
    `PGDATA=${pgdata}`,
    ...env,
    ...extraEnv,
    IMAGE,
    "postgres",
    "-c",
    "archive_mode=off",
  ]);
  return c;
}

beforeAll(() => {
  // Build context is the repository root, as the release and compose builds use.
  ok(["build", "-f", "infra/postgres/Containerfile", "-t", IMAGE, "."], 20 * 60_000);
  ok(["volume", "create", VOLUME]);
  ok([
    "run",
    "--rm",
    "-v",
    `${VOLUME}:/backup`,
    "--entrypoint",
    "sh",
    IMAGE,
    "-c",
    "mkdir -p /backup/archive && chown -R postgres:postgres /backup",
  ]);
}, 25 * 60_000);

afterAll(() => {
  for (const role of ["primary", "slow", "stuck", "nostart"]) podman(["rm", "-f", "-t", "0", name(role)]);
  podman(["volume", "rm", "-f", VOLUME]);
  podman(["rmi", "-f", IMAGE]);
}, 120_000);

describe("commonair-pg-health", () => {
  test("a primary that accepts connections is ready; two base backups and archived WAL", async () => {
    const c = name("primary");
    ok([
      "run",
      "-d",
      "--init",
      "--name",
      c,
      "-v",
      `${VOLUME}:/backup`,
      ...env,
      IMAGE,
      "postgres",
      "-c",
      "wal_level=replica",
      "-c",
      "archive_mode=on",
      "-c",
      "archive_command=cp %p /backup/archive/%f",
    ]);
    // The entrypoint's first-run init uses a temporary server; wait for the real one.
    await until("init to finish", 120_000, () =>
      podman(["logs", c]).out.includes("PostgreSQL init process complete") ? true : undefined,
    );
    await until("primary ready", 60_000, () => (health(c).code === 0 ? true : undefined));
    expect(health(c, ["--startup"]).code).toBe(0);

    for (const dir of ["slow", "stuck"])
      ok([
        "exec",
        "-u",
        "postgres",
        c,
        "pg_basebackup",
        "-U",
        "commonair",
        "-D",
        `/backup/${dir}`,
        "-X",
        "stream",
        "-c",
        "fast",
      ]);
    psql(c, "create table replayed (n int)");
    for (let i = 0; i < SEGMENTS; i++)
      psql(c, `insert into replayed select generate_series(1, 1000); select pg_switch_wal()`);
    // A clean stop archives every finished segment first.
    ok(["stop", "-t", "60", c], 90_000);
    const archived = ok(["run", "--rm", "-v", `${VOLUME}:/backup`, "--entrypoint", "ls", IMAGE, "/backup/archive"]);
    expect(archived.split("\n").filter((f) => /^[0-9A-F]{24}$/.test(f)).length).toBeGreaterThanOrEqual(SEGMENTS);
  }, 300_000);

  test("a slow replay that keeps advancing is reported as progressing and never stopped", async () => {
    // Every fetch takes 3 s, so the replay outlasts the 10 s bound several times over.
    const bound = ["-e", "COMMONAIR_PG_STALL_SECONDS=10"];
    const c = startRecovery("slow", "slow", "sleep 3 && cp /backup/archive/%f %p", bound);
    const codes: number[] = [];
    const regular: number[] = [];
    const alive: boolean[] = [];
    const progress: string[] = [];
    await until("replay to finish", 240_000, () => {
      alive.push(running(c));
      const r = health(c, ["--startup"], bound);
      codes.push(r.code);
      if (r.out.includes("replaying")) progress.push(r.out.trim());
      // The regular check never stops anything; it is plainly not ready during replay.
      if (r.code !== 0) regular.push(health(c).code);
      return r.code === 0 || !alive.at(-1) ? true : undefined;
    });
    expect(alive.every(Boolean), podman(["logs", c]).out).toBe(true);
    expect(codes).not.toContain(2);
    // Only the last regular check may race the promotion and already pass.
    expect(new Set(regular.slice(0, -1))).toEqual(new Set([1]));
    expect([0, 1]).toContain(regular.at(-1));
    expect(codes.filter((x) => x === 1).length).toBeGreaterThanOrEqual(10);
    // The title names the segment being fetched or replayed, and it moves.
    const segments = progress.flatMap((p) => /startup (?:recovering|waiting for) ([0-9A-F]{24})/.exec(p)?.[1] ?? []);
    expect(new Set(segments).size, progress.join("\n")).toBeGreaterThanOrEqual(3);
    expect(psql(c, "select pg_is_in_recovery()")).toBe("f");
    expect(psql(c, "select count(*) from replayed")).toBe(String(SEGMENTS * 1000));
    expect(health(c).code).toBe(0);
  }, 300_000);

  test("a replay that is stuck is reported failing after the bound and the server is stopped", async () => {
    const bound = ["-e", "COMMONAIR_PG_STALL_SECONDS=6"];
    const c = startRecovery("stuck", "stuck", "sleep 3600", bound);
    // Until the startup process waits on the hung restore_command, it is starting.
    await until("startup process", 60_000, () =>
      health(c, ["--startup"], bound).out.includes("replaying") ? true : undefined,
    );
    const started = Date.now();
    const codes: number[] = [];
    await until("stuck verdict", 60_000, () => {
      codes.push(health(c, ["--startup"], bound).code);
      return codes.at(-1) === 1 ? undefined : true;
    });
    // Not ready until the bound, then stuck exactly once.
    expect(codes.at(-1)).toBe(2);
    expect(new Set(codes.slice(0, -1))).toEqual(new Set([1]));
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
    await until("container to exit", 60_000, () => (running(c) ? undefined : true));
    expect(podman(["logs", c]).out).toMatch(/immediate shutdown request/);
  }, 300_000);

  test("a normal start that never comes up is stopped after the start bound", async () => {
    const c = name("nostart");
    ok(["run", "-d", "--init", "--name", c, ...env, "--entrypoint", "sleep", IMAGE, "3600"]);
    const bound = ["-e", "COMMONAIR_PG_START_SECONDS=4"];
    expect(health(c, ["--startup"], bound).code).toBe(1);
    // The regular check alone never stops anything.
    expect(health(c).code).toBe(1);
    await sleep(5000);
    expect(health(c, ["--startup"], bound).code).toBe(2);
    await until("container to exit", 30_000, () => (running(c) ? undefined : true));
  }, 120_000);
});
