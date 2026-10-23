// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The first start of the real postgres image on an empty volume while S3 is unreachable, as on
 * a first self-host install before Garage, its bucket and key are up. CI's Debian e2e failed
 * there: the temporary server initdb runs had WAL archiving on, its stop waited on wal-push to
 * the unreachable endpoint, pg_ctl gave up after 60 s and the unit failed. The init server now
 * runs with archive_mode=off; the real server must still archive. Needs podman.
 */
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const ROOT = new URL("../../", import.meta.url).pathname;
const SUFFIX = crypto.randomUUID().slice(0, 8);
const IMAGE = `localhost/commonair/postgres:init-it-${SUFFIX}`;
const CONTAINER = `commonair-pginit-${SUFFIX}`;
const VOLUME = `commonair-pginit-${SUFFIX}`;

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
const running = () => podman(["inspect", CONTAINER, "--format", "{{.State.Running}}"]).out.trim() === "true";
const psql = (sql: string) =>
  podman(
    ["exec", "-u", "postgres", CONTAINER, "psql", "-XqAt", "-U", "commonair", "-d", "commonair", "-c", sql],
    30_000,
  );

beforeAll(() => {
  // Build context is the repository root, as the release and compose builds use.
  ok(["build", "-f", "infra/postgres/Containerfile", "-t", IMAGE, "."], 20 * 60_000);
  ok(["volume", "create", VOLUME]);
}, 21 * 60_000);

afterAll(() => {
  podman(["rm", "-f", "-t", "0", CONTAINER]);
  podman(["volume", "rm", "-f", VOLUME]);
  podman(["rmi", "-f", IMAGE]);
});

test("a first start with S3 unreachable initializes and comes up, then archives", async () => {
  ok([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-v",
    `${VOLUME}:/var/lib/postgresql/data`,
    "-e",
    "POSTGRES_USER=commonair",
    "-e",
    "POSTGRES_DB=commonair",
    "-e",
    "POSTGRES_PASSWORD=it",
    // A non-routable address: every wal-push hangs until its 20 s timeout, as on CI.
    "-e",
    "WALG_S3_ENDPOINT=http://10.255.255.1:3900",
    "-e",
    "S3_ACCESS_KEY_ID=it",
    "-e",
    "S3_SECRET_ACCESS_KEY=it",
    IMAGE,
  ]);
  // Before the fix the init server's stop took 60 s and then failed; allow well under that.
  const end = Date.now() + 45_000;
  let up = false;
  while (Date.now() < end) {
    if (!running()) break;
    const logs = podman(["logs", CONTAINER]).out;
    if (logs.includes("init process complete") && psql("select 1").out.trim() === "1") {
      up = true;
      break;
    }
    await sleep(1000);
  }
  if (!up) throw new Error(`postgres did not come up:\n${podman(["logs", CONTAINER]).out.slice(-3000)}`);
  // The real server keeps archiving: only the init server ran without it.
  expect(psql("show archive_mode").out.trim()).toBe("on");
  expect(psql("show archive_command").out.trim()).toContain("wal-g wal-push");
  // And the server runs as postgres, as the stock entrypoint's own re-exec would have it.
  expect(ok(["exec", CONTAINER, "sh", "-c", "ps -o user= -p 1 2>/dev/null || stat -c %U /proc/1"]).trim()).toBe(
    "postgres",
  );
}, 120_000);
