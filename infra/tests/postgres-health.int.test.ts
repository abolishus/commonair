// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs commonair-pg-health (infra/postgres/health.sh) in the real postgres image against a
 * server in each state the unit must tell apart: accepting connections (ready), replaying
 * archived WAL slowly but advancing (not ready, never stopped), replay stuck (stopped after
 * the bound), and a server that never comes up on a normal start (stopped after its bound).
 * The bounds are shortened through the script's environment. The same states are then run under
 * the health flags the Quadlet unit generates, driven by `podman healthcheck run`, to check that
 * Podman itself never kills an advancing replay. Last, commonair-wal-fetch (the restore_command
 * commonair-restore writes) must stop recovery when the bucket fails instead of promoting early.
 * Also: where the startup check keeps its state, that a stale state file from an earlier run of
 * the container is ignored, and the SIGKILL escalation of a stop that does not take.
 * Needs podman.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../../", import.meta.url).pathname;
const SUFFIX = crypto.randomUUID().slice(0, 8);
const IMAGE = `localhost/commonair/postgres:health-it-${SUFFIX}`;
const VOLUME = `commonair-pgh-${SUFFIX}`;
const name = (role: string) => `commonair-pgh-${role}-${SUFFIX}`;
const SEGMENTS = 8;
const BACKUPS = ["slow", "stuck", "pslow", "pstuck", "fetchfail"];
/** The health flags infra/quadlet/commonair-postgres.container generates, with short intervals. */
const QUADLET_HEALTH = [
  "--health-cmd",
  "commonair-pg-health",
  "--health-interval",
  "1s",
  "--health-timeout",
  "5s",
  "--health-retries",
  "2",
  "--health-on-failure",
  "kill",
  "--health-startup-cmd",
  "commonair-pg-health --startup",
  "--health-startup-interval",
  "1s",
  "--health-startup-timeout",
  "5s",
  "--health-startup-retries",
  "0",
];
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
const status = (c: string) => podman(["inspect", c, "--format", "{{.State.Health.Status}}"]).out.trim();
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
function startRecovery(
  role: string,
  dir: string,
  restoreCommand: string,
  extraEnv: string[],
  runArgs: string[] = [],
): string {
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
    ...runArgs,
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
  for (const role of [
    "primary",
    "slow",
    "stuck",
    "nostart",
    "pslow",
    "pstuck",
    "fetchfail",
    "walfetch",
    "state",
    "stale",
    "noquit",
    "noterm",
  ])
    podman(["rm", "-f", "-t", "0", name(role)]);
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

    for (const dir of BACKUPS)
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

describe("under Podman's health checks (the Quadlet unit's flags)", () => {
  test("an advancing replay is never killed, and the container turns healthy after promotion", async () => {
    // A 3 s fetch against two 1 s regular-check retries: any regular check run during the replay,
    // or any startup failure counted towards a kill, would stop this container.
    const bound = ["-e", "COMMONAIR_PG_STALL_SECONDS=30"];
    const c = startRecovery("pslow", "pslow", "sleep 3 && cp /backup/archive/%f %p", bound, QUADLET_HEALTH);
    const alive: boolean[] = [];
    const statuses: string[] = [];
    await until("healthy", 240_000, () => {
      podman(["healthcheck", "run", c], 30_000);
      alive.push(running(c));
      statuses.push(status(c));
      return statuses.at(-1) === "healthy" || !alive.at(-1) ? true : undefined;
    });
    expect(alive.every(Boolean), `${statuses.join(",")}\n${podman(["logs", c]).out}`).toBe(true);
    expect(statuses.at(-1)).toBe("healthy");
    // The replay ran long enough for the checks to matter.
    expect(statuses.filter((x) => x !== "healthy").length).toBeGreaterThanOrEqual(10);
    expect(statuses).not.toContain("unhealthy");
    expect(psql(c, "select count(*) from replayed")).toBe(String(SEGMENTS * 1000));
    // Healthy now means the regular check runs; a few more runs keep it healthy.
    for (let i = 0; i < 3; i++) expect(podman(["healthcheck", "run", c], 30_000).code).toBe(0);
    expect(running(c)).toBe(true);
  }, 300_000);

  test("a stuck replay still makes the container exit", async () => {
    const bound = ["-e", "COMMONAIR_PG_STALL_SECONDS=6"];
    const c = startRecovery("pstuck", "pstuck", "sleep 3600", bound, QUADLET_HEALTH);
    const started = Date.now();
    await until("container to exit", 120_000, () => {
      podman(["healthcheck", "run", c], 30_000);
      return running(c) ? undefined : true;
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
    expect(podman(["logs", c]).out).toMatch(/immediate shutdown request/);
  }, 180_000);
});

describe("the startup check's state and its stop", () => {
  const STATE = "/run/commonair-pg-health.state";
  /** A container where Postgres never starts: the start bound applies, PID 1 is catatonit. */
  function idle(role: string, entrypoint = ["sleep", "3600"]): string {
    const c = name(role);
    ok(["run", "-d", "--init", "--name", c, ...env, "--entrypoint", entrypoint[0]!, IMAGE, ...entrypoint.slice(1)]);
    return c;
  }
  const exists = (c: string, path: string) => podman(["exec", c, "test", "-e", path]).code === 0;

  test("the state lives in /run, not the world-writable /tmp", () => {
    const c = idle("state");
    expect(health(c, ["--startup"], ["-e", "COMMONAIR_PG_START_SECONDS=100"]).code).toBe(1);
    expect(exists(c, STATE)).toBe(true);
    expect(ok(["exec", c, "ls", "-A", "/tmp"]).trim()).toBe("");
    // The regular check (not ready either) leaves it alone.
    expect(health(c).code).toBe(1);
    expect(exists(c, STATE)).toBe(true);
  }, 60_000);

  test("a marker left by an earlier run of the container does not make a fresh start look stalled", async () => {
    const c = idle("stale");
    const bound = ["-e", "COMMONAIR_PG_START_SECONDS=4"];
    expect(health(c, ["--startup"], bound).code).toBe(1);
    await sleep(5000);
    // A restart keeps the writable layer, so the old run's state file (with no postmaster, the
    // same "pm= title=" as now) is still there and already past the bound.
    ok(["restart", "-t", "0", c]);
    expect(exists(c, STATE)).toBe(true);
    expect(health(c, ["--startup"], bound).code).toBe(1);
    // The bound still applies to this run: the same check fails once it has passed.
    await sleep(5000);
    expect(health(c, ["--startup"], bound).code).toBe(2);
    await until("container to exit", 30_000, () => (running(c) ? undefined : true));
  }, 120_000);

  test("a postmaster that ignores SIGQUIT gets SIGKILL after the grace period", async () => {
    const c = idle("noquit");
    // A process named postgres (argv[0]) that ignores SIGQUIT, recorded in a postmaster.pid.
    ok([
      "exec",
      "-d",
      c,
      "sh",
      "-c",
      'mkdir -p /tmp/fake /tmp/pgdata && ln -sf /bin/sleep /tmp/fake/postgres && trap "" QUIT && ' +
        "PATH=/tmp/fake:$PATH && { postgres 3600 & echo $! > /tmp/pgdata/postmaster.pid; wait; }",
    ]);
    const pid = await until("fake postmaster", 10_000, () => {
      const r = podman(["exec", c, "cat", "/tmp/pgdata/postmaster.pid"]);
      return r.code === 0 && /^\d+\n/.test(r.out) ? r.out.trim() : undefined;
    });
    const alive = () => podman(["exec", c, "test", "-d", `/proc/${pid}`]).code === 0;
    const run = [
      "-e",
      "PGDATA=/tmp/pgdata",
      "-e",
      "COMMONAIR_PG_START_SECONDS=0",
      "-e",
      "COMMONAIR_PG_KILL_GRACE_SECONDS=3",
    ];
    const started = Date.now();
    const r = health(c, ["--startup"], run);
    // The check returns at once with its usual code; the watcher does the waiting.
    expect(r.code).toBe(2);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(alive()).toBe(true);
    await until("SIGKILL", 20_000, () => (alive() ? undefined : true));
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    expect(podman(["logs", c]).out).toMatch(/postmaster \d+ still running 3s after SIGQUIT; sending SIGKILL/);
    // Only the postmaster: the container (catatonit's sleep) is untouched.
    expect(running(c)).toBe(true);
  }, 60_000);

  test("an entrypoint that ignores SIGTERM is killed after the grace period, so the container exits", async () => {
    const c = idle("noterm", ["sh", "-c", 'trap "" TERM; while :; do sleep 1; done']);
    const run = ["-e", "COMMONAIR_PG_START_SECONDS=0", "-e", "COMMONAIR_PG_KILL_GRACE_SECONDS=3"];
    const started = Date.now();
    expect(health(c, ["--startup"], run).code).toBe(2);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(running(c)).toBe(true);
    await until("container to exit", 30_000, () => (running(c) ? undefined : true));
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    expect(podman(["logs", c]).out).toMatch(/container still running 3s after SIGTERM; sending SIGKILL/);
  }, 60_000);

  test("a postmaster that does stop gets no SIGKILL", async () => {
    // The stuck replay above stopped on SIGQUIT; its watcher died with the container.
    const logs = podman(["logs", name("stuck")]).out;
    expect(logs).toMatch(/immediate shutdown request/);
    expect(logs).not.toMatch(/sending SIGKILL/);
  });
});

describe("commonair-wal-fetch", () => {
  test("maps wal-g's exit status: found 0, not found 1, any other failure 126", () => {
    // A stand-in wal-g on PATH that exits with the status it is told to.
    const fake =
      'mkdir -p /tmp/fake && printf "#!/bin/sh\\nexit \\$FAKE_RC\\n" > /tmp/fake/wal-g && chmod +x /tmp/fake/wal-g';
    const codes = ok([
      "run",
      "--rm",
      "--name",
      name("walfetch"),
      "--entrypoint",
      "sh",
      IMAGE,
      "-c",
      `${fake}; for rc in 0 74 1 2 124 137; do FAKE_RC=$rc PATH=/tmp/fake:$PATH commonair-wal-fetch 000000010000000000000001 /tmp/out 2>/dev/null; echo "$rc=$?"; done`,
    ]);
    expect(codes.trim().split("\n")).toEqual(["0=0", "74=1", "1=126", "2=126", "124=126", "137=126"]);
  });

  test("real wal-g: a missing segment is not found (74), an unreachable bucket is not", () => {
    const out = ok([
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      IMAGE,
      "-c",
      "mkdir -p /tmp/st; WALG_FILE_PREFIX=/tmp/st wal-g wal-fetch 000000010000000000000001 /tmp/o 2>/dev/null; echo missing=$?; " +
        "WALG_S3_PREFIX=s3://b/p AWS_ENDPOINT=http://127.0.0.1:1 AWS_ACCESS_KEY_ID=a AWS_SECRET_ACCESS_KEY=b WALG_S3_MAX_RETRIES=0 " +
        "commonair-wal-fetch 000000010000000000000001 /tmp/o 2>/dev/null; echo unreachable=$?",
    ]);
    expect(out).toContain("missing=74");
    expect(out).toContain("unreachable=126");
  });

  test("a replay whose bucket is unreachable stops instead of promoting early", async () => {
    const bucket = [
      "-e",
      "WALG_S3_PREFIX=s3://commonair-backups/wal",
      "-e",
      "AWS_ENDPOINT=http://127.0.0.1:1",
      "-e",
      "AWS_ACCESS_KEY_ID=it",
      "-e",
      "AWS_SECRET_ACCESS_KEY=it",
      "-e",
      "WALG_S3_MAX_RETRIES=0",
    ];
    const c = startRecovery("fetchfail", "fetchfail", "/usr/local/bin/commonair-wal-fetch %f %p", bucket);
    await until("container to exit", 120_000, () => (running(c) ? undefined : true));
    const logs = podman(["logs", c]).out;
    expect(logs).toMatch(/stopping recovery instead of promoting early/);
    expect(logs).not.toMatch(/selected new timeline ID|archive recovery complete/);
    // Recovery never ended (Postgres removes recovery.signal when it does), so the next start
    // resumes the replay.
    const left = ok(["run", "--rm", "-v", `${VOLUME}:/backup`, "--entrypoint", "ls", IMAGE, "/backup/fetchfail"]);
    expect(left.split("\n")).toContain("recovery.signal");
  }, 180_000);
});
