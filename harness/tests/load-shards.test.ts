// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { allocateViewers, loadTopology, plannedShards, plannedShardsOn } from "../src/load.ts";
import { loadLoadEnv } from "../src/load/env.ts";
import {
  FORWARDED_ENV_KEYS,
  LOCAL_HOST,
  RemoteShardProcess,
  type ShardChild,
  WORKER_RELATIVE,
  assignShardHosts,
  forwardedEnv,
  readLines,
  remoteWorkerCommand,
  remoteWorkerScript,
} from "../src/load/processes.ts";
import { type WorkerSpec, formatShardLine } from "../src/load/shard.ts";
import { shellQuote } from "../src/load/ssh.ts";
import { emptyReport } from "../src/viewer.ts";

describe("remote shard assignment", () => {
  test("no host list: every shard local", () => {
    expect(assignShardHosts(3, [])).toEqual([LOCAL_HOST, LOCAL_HOST, LOCAL_HOST]);
  });

  test("hosts dealt round-robin, local included when listed", () => {
    expect(assignShardHosts(5, ["root@g1", "local", "root@g2"])).toEqual([
      "root@g1",
      "local",
      "root@g2",
      "root@g1",
      "local",
    ]);
    expect(assignShardHosts(1, [" root@g1 ", ""])).toEqual(["root@g1"]);
    expect(assignShardHosts(0, ["root@g1"])).toEqual([]);
    expect(() => assignShardHosts(-1, [])).toThrow(RangeError);
  });

  test("with a host list every host takes part, never more shards than HTTP viewers", () => {
    const alloc = allocateViewers(2, 500, 10);
    expect(plannedShards(alloc, 1_000)).toBe(0);
    expect(plannedShardsOn(alloc, 1_000, [])).toBe(0);
    expect(plannedShardsOn(alloc, 1_000, ["g1", "g2"])).toBe(2);
    expect(plannedShardsOn(alloc, 100, ["g1", "g2"])).toBe(5);
    expect(plannedShardsOn(allocateViewers(1, 3, 0), 1_000, ["g1", "g2", "g3", "g4"])).toBe(3);
    expect(plannedShardsOn(allocateViewers(1, 2, 2), 1_000, ["g1"])).toBe(0);
  });

  test("the topology lists remote generators once, without `local`", () => {
    const topo = loadTopology(
      loadLoadEnv({
        HARNESS_LOAD_GENERATOR_HOSTS: "local,root@g1,root@g1,root@g2",
        HARNESS_LOAD_TARGET_SSH: "commonair@t",
      }),
      async () => ({ code: 0, stdout: "" }),
    );
    expect(topo.target).toBe("commonair@t");
    expect(topo.remoteGenerators).toEqual(["root@g1", "root@g2"]);
    expect(loadTopology(loadLoadEnv({})).target).toBeNull();
  });
});

describe("the remote worker command", () => {
  const worker: WorkerSpec = {
    shard: { index: 2, channels: [{ channel: "o'brien", http: 3 }] },
    runId: "r1",
    maxMs: 1000,
  };

  test("only the instance URLs cross to the other host", () => {
    const env = forwardedEnv({
      HARNESS_API_URL: "https://stream.example.org",
      HARNESS_WEB_URL: "https://stream.example.org",
      HARNESS_MAILPIT_AUTH: "user:secret",
      DATABASE_URL: "postgres://secret",
      LOG_LEVEL: "info",
      HARNESS_ORIGIN_URL: " ",
    });
    expect(env).toEqual({
      HARNESS_API_URL: "https://stream.example.org",
      HARNESS_WEB_URL: "https://stream.example.org",
      LOG_LEVEL: "info",
    });
    expect(FORWARDED_ENV_KEYS).not.toContain("HARNESS_MAILPIT_AUTH");
  });

  test("cd to the checkout, run the worker in the background, SIGINT it when stdin closes", () => {
    const cmd = remoteWorkerCommand("/srv/commonair repo", worker, { HARNESS_API_URL: "https://x.example.org" });
    expect(cmd.startsWith("sh -c '")).toBe(true);
    expect(cmd).toContain("/srv/commonair repo");
    expect(cmd).toContain(WORKER_RELATIVE);
    expect(cmd).toContain("cat >/dev/null");
    expect(cmd).toContain('kill -INT "$pid"');
    expect(cmd).toContain('wait "$pid"');
  });

  test("the script survives the shell: run it with the worker swapped for a stand-in", async () => {
    const script = remoteWorkerScript(
      "/",
      worker,
      { HARNESS_API_URL: "https://x.example.org/?a='b'" },
      `sh -c 'printf "%s|%s\\n" "$HARNESS_API_URL" "$1"' x`,
    );
    expect(remoteWorkerCommand("/", worker, {})).toBe(`sh -c ${shellQuote(remoteWorkerScript("/", worker, {}))}`);
    const proc = Bun.spawn(["sh", "-c", script], { stdin: "pipe", stdout: "pipe" });
    void proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const [url, spec] = out.trim().split("|");
    expect(url).toBe("https://x.example.org/?a='b'");
    expect(JSON.parse(spec ?? "")).toEqual(worker);
  });
});

/** A fake ssh child: stdout lines are pushed by the test; closing stdin can trigger the reports. */
function fakeChild(onStdinClosed: (c: FakeChild) => void = () => undefined) {
  let push: (line: string) => void = () => undefined;
  let close: () => void = () => undefined;
  let exit: (code: number) => void = () => undefined;
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => controller.enqueue(enc.encode(`${line}\r\n`));
      close = () => controller.close();
    },
  });
  const exited = new Promise<number>((resolve) => {
    exit = (code) => {
      close();
      resolve(code);
    };
  });
  const c: FakeChild = {
    argv: [] as string[],
    stdinClosed: 0,
    killed: 0,
    push: (l: string) => push(l),
    exit: (code: number) => exit(code),
    child: {
      stdout,
      stderr: new ReadableStream({ start: (ctl) => ctl.close() }),
      exited,
      closeStdin: () => {
        c.stdinClosed++;
        onStdinClosed(c);
      },
      kill: () => {
        c.killed++;
        exit(137);
      },
    },
  };
  return c;
}
interface FakeChild {
  argv: string[];
  stdinClosed: number;
  killed: number;
  push(line: string): void;
  exit(code: number): void;
  child: ShardChild;
}

describe("RemoteShardProcess", () => {
  const worker: WorkerSpec = { shard: { index: 1, channels: [{ channel: "a", http: 2 }] }, runId: "r", maxMs: 1000 };
  const reports = [emptyReport("v1", "http", "http"), emptyReport("v2", "http", "http")];

  test("ssh to the host, started over stdout, stop by closing stdin, reports back", async () => {
    const fake = fakeChild((c) => {
      c.push(formatShardLine({ type: "reports", shard: 1, reports }));
      c.exit(0);
    });
    const shard = new RemoteShardProcess("root@g1", worker, {
      repo: "/srv/repo",
      env: {},
      spawn: (argv) => {
        fake.argv = argv;
        return fake.child;
      },
    });
    expect(fake.argv[0]).toBe("ssh");
    expect(fake.argv).toContain("root@g1");
    expect(shard.host).toBe("root@g1");
    fake.push("some log line");
    fake.push(formatShardLine({ type: "started", shard: 1, viewers: 2 }));
    expect(await shard.waitStarted(1_000)).toBe(2);
    expect((await shard.stop()).map((r) => r.id)).toEqual(["v1", "v2"]);
    expect(fake.stdinClosed).toBe(1);
    expect(fake.killed).toBe(0);
  });

  test("ssh dying halfway fails the shard with the host named", async () => {
    const fake = fakeChild();
    const shard = new RemoteShardProcess("root@g2", worker, {
      repo: "/r",
      env: {},
      spawn: () => fake.child,
      drainMs: 10,
    });
    fake.push(formatShardLine({ type: "started", shard: 1, viewers: 2 }));
    expect(await shard.waitStarted(1_000)).toBe(2);
    fake.exit(255);
    await expect(shard.stop()).rejects.toThrow(/load shard 1 exited \(255\): root@g2:/);
  });

  test("an error line from the worker fails start", async () => {
    const fake = fakeChild();
    const shard = new RemoteShardProcess("root@g3", worker, { repo: "/r", env: {}, spawn: () => fake.child });
    fake.push(formatShardLine({ type: "error", shard: 1, error: "playback start: HTTP 429" }));
    await expect(shard.waitStarted(1_000)).rejects.toThrow(/HTTP 429/);
    await shard.kill();
    expect(fake.killed).toBe(1);
  });

  test("a worker that never answers the stop is killed after the grace", async () => {
    const fake = fakeChild();
    const shard = new RemoteShardProcess("root@g4", worker, {
      repo: "/r",
      env: {},
      spawn: () => fake.child,
      stopGraceMs: 20,
      drainMs: 10,
    });
    await expect(shard.stop()).rejects.toThrow(/load shard 1/);
    expect(fake.killed).toBe(1);
  });
});

describe("readLines", () => {
  test("splits on \\n, \\r\\n and \\r across chunks; keeps a last unterminated line", async () => {
    const enc = new TextEncoder();
    const chunks = ["a\r", "\nb\nc", "d\re", "\n\nlast"];
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (const c of chunks) ctl.enqueue(enc.encode(c));
        ctl.close();
      },
    });
    const lines: string[] = [];
    await readLines(stream, (l) => lines.push(l));
    expect(lines).toEqual(["a", "b", "cd", "e", "last"]);
  });
});
