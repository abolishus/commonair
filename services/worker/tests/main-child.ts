// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Runs src/main.ts as a child on a port it binds itself (listen-preload.ts); not a test file. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./fixtures.ts";

export interface MainChild {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  /** GET a path on the child; throws if the answer came from any other process. */
  get(path: string): Promise<Response>;
}

export async function startMainChild(env: Record<string, string>): Promise<MainChild> {
  const dir = mkdtempSync(join(tmpdir(), "worker-main-"));
  const report = join(dir, "listen.json");
  const instance = crypto.randomUUID();
  const child = Bun.spawn(
    [
      "bun",
      "--preload",
      fileURLToPath(new URL("./listen-preload.ts", import.meta.url)),
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
    ],
    {
      // WORKER_PORT only has to pass the env schema: the preload binds port 0 instead.
      env: { ...process.env, ...env, WORKER_PORT: "3005", TEST_LISTEN_REPORT: report, TEST_INSTANCE: instance },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let exited: number | null = null;
  void child.exited.then((code) => (exited = code));
  try {
    const listening = await waitFor(
      async () => {
        if (exited !== null) throw new Error(`worker main exited with ${exited} before listening`);
        try {
          return JSON.parse(readFileSync(report, "utf8")) as { pid: number; port: number };
        } catch {
          return false;
        }
      },
      { timeoutMs: 15_000, intervalMs: 50, label: "worker main listening" },
    );
    if (listening.pid !== child.pid) throw new Error(`listen report from pid ${listening.pid}, not ${child.pid}`);
    const base = `http://127.0.0.1:${listening.port}`;
    return {
      child,
      async get(path) {
        const res = await fetch(`${base}${path}`);
        const seen = res.headers.get("x-test-instance");
        if (seen !== instance) throw new Error(`${path} answered by another process (instance ${seen ?? "none"})`);
        return res;
      },
    };
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
