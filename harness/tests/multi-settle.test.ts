// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { SCENARIO_TIMEOUT_MS, SETTLE_FLOOR_MS, SETTLE_MS, TEARDOWN_RESERVE_MS } from "../scenarios/multi-instance.ts";
import type { PodmanResult } from "../src/drill/podman.ts";
import {
  type Exec,
  type RestoreOps,
  SMTP_CONNECT_SCRIPT,
  readinessProbe,
  readyzScript,
  restoreContainer,
  smtpProbe,
  stackProbes,
} from "../src/multi/podman-ops.ts";
import { parseReplicaContainers } from "../src/multi/replicas.ts";
import {
  DEFAULT_STABLE_MS,
  type NetworkProbe,
  NetworkNotSettledError,
  failingProbes,
  waitForNetwork,
} from "../src/multi/settle.ts";

/** A clock that only moves when the code under test sleeps. */
function fakeClock(onSleep: (t: number) => void = () => undefined) {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      onSleep(t);
    },
    get t() {
      return t;
    },
  };
}

function probe(name: string, check: () => string | null | Promise<string | null>): NetworkProbe & { calls: number } {
  const p = {
    name,
    calls: 0,
    async check() {
      p.calls++;
      return check();
    },
  };
  return p;
}

const upOps = (calls: string[] = []): Partial<RestoreOps> => ({
  running: async () => true,
  start: async (n) => {
    calls.push(`start ${n}`);
  },
  healthy: async () => true,
});

describe("restoreContainer settles the network", () => {
  test("does not return while a dependent probe fails, and returns once it passes", async () => {
    let mediamtxUp = false;
    let resolved = false;
    let roundsWhileDown = 0;
    const clock = fakeClock(() => {
      if (!mediamtxUp) roundsWhileDown++;
      // The restore must still be waiting on every round the probe failed.
      expect(resolved).toBe(false);
      if (roundsWhileDown === 8) mediamtxUp = true;
    });
    const media = probe("media /readyz", () => (mediamtxUp ? null : 'exit 1: 503 {"checks":{"mediamtx":"fail"}}'));
    const api = probe("api /readyz", () => null);
    const p = restoreContainer("commonair_worker-2_1", "http://localhost:3105/healthz", {
      ops: upOps(),
      settle: { probes: [media, api], timeoutMs: 60_000, stableMs: 3_000, intervalMs: 1_000, ...clock },
    }).then((r) => {
      resolved = true;
      return r;
    });
    const r = await p;
    expect(mediamtxUp).toBe(true);
    expect(roundsWhileDown).toBe(8);
    // 8 failing rounds (8 s), then passing rounds at +8 s … +11 s: stable for 3 s.
    expect(r.settledMs).toBe(11_000);
    expect(media.calls).toBe(12);
    expect(api.calls).toBe(12);
  });

  test("throws at the settle deadline, naming the probe that still fails and why", async () => {
    const clock = fakeClock();
    const err = await restoreContainer("commonair_chat-2_1", "http://localhost:3102/healthz", {
      ops: upOps(),
      settle: {
        probes: [probe("api → SMTP", () => "exit 1: ETIMEDOUT"), probe("api /readyz", () => null)],
        timeoutMs: 20_000,
        ...clock,
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkNotSettledError);
    const e = err as NetworkNotSettledError;
    expect(e.failing).toEqual([{ name: "api → SMTP", reason: "exit 1: ETIMEDOUT" }]);
    expect(e.message).toContain("api → SMTP: exit 1: ETIMEDOUT");
    expect(e.message).not.toContain("api /readyz");
    expect(e.message).toContain("20000 ms");
  });

  test("starts a stopped container, and leaves a running one alone", async () => {
    const calls: string[] = [];
    await restoreContainer("c1", "http://x/healthz", { ops: { ...upOps(calls), running: async () => false } });
    await restoreContainer("c2", "http://x/healthz", { ops: upOps(calls) });
    expect(calls).toEqual(["start c1"]);
  });

  test("without settle probes it returns once the health URL answers", async () => {
    let n = 0;
    const r = await restoreContainer("c", "http://x/healthz", {
      healthIntervalMs: 1,
      ops: { ...upOps(), healthy: async () => ++n >= 3 },
    });
    expect(n).toBe(3);
    expect(r.settledMs).toBe(0);
  });

  test("does not probe the network before the container is healthy", async () => {
    let healthyNow = false;
    const net = probe("api /readyz", () => {
      expect(healthyNow).toBe(true);
      return null;
    });
    let n = 0;
    await restoreContainer("c", "http://x/healthz", {
      healthIntervalMs: 1,
      ops: { ...upOps(), healthy: async () => (healthyNow = ++n >= 2) },
      settle: { probes: [net], timeoutMs: 10_000, stableMs: 0, ...fakeClock() },
    });
    expect(net.calls).toBe(1);
  });

  test("a health URL that never answers fails before any settle probe runs", async () => {
    const net = probe("api /readyz", () => null);
    await expect(
      restoreContainer("c", "http://x/healthz", {
        timeoutMs: 20,
        healthIntervalMs: 5,
        ops: { ...upOps(), healthy: async () => false },
        settle: { probes: [net], timeoutMs: 10_000 },
      }),
    ).rejects.toThrow(/c healthy at http:\/\/x\/healthz/);
    expect(net.calls).toBe(0);
  });
});

describe("waitForNetwork", () => {
  test("a failure inside the stable window restarts it", async () => {
    // pass, pass, fail, then passing: the early passes must not count.
    const script = [null, null, "exit 1: timeout"];
    let i = 0;
    const flappy = probe("media /readyz", () => (i < script.length ? (script[i++] ?? null) : null));
    const clock = fakeClock();
    const ms = await waitForNetwork([flappy], { timeoutMs: 60_000, stableMs: 3_000, intervalMs: 1_000, ...clock });
    // The failure is at +2 s; passing again from +3 s, stable at +6 s.
    expect(ms).toBe(6_000);
  });

  test("the default window does not end in a 5 s lull between failures (run 42244605154)", async () => {
    // Failing 3 s, passing 5 s (a healthcheck gap), failing 3 s again, then passing for good.
    const clock = fakeClock();
    const start = clock.t;
    const failingAt = (ms: number) => ms < 3_000 || (ms >= 8_000 && ms < 11_000);
    const p = probe("api -> mailpit", () => (failingAt(clock.t - start) ? "exit 1: ETIMEDOUT" : null));
    const ms = await waitForNetwork([p], { timeoutMs: 60_000, intervalMs: 1_000, now: clock.now, sleep: clock.sleep });
    // Not in the lull (3 s to 8 s): only after a full default window from 11 s.
    expect(ms).toBe(11_000 + DEFAULT_STABLE_MS);
  });

  test("the default window outlasts two 5 s healthcheck intervals", () => {
    expect(DEFAULT_STABLE_MS).toBeGreaterThanOrEqual(10_000);
  });

  test("returns at once with no probes", async () => {
    expect(await waitForNetwork([], { timeoutMs: 0 })).toBe(0);
  });

  test("stableMs 0 returns on the first passing round", async () => {
    const p = probe("p", () => null);
    expect(await waitForNetwork([p], { timeoutMs: 1_000, stableMs: 0, ...fakeClock() })).toBe(0);
    expect(p.calls).toBe(1);
  });

  test("passing at the deadline but not for the stable window still fails, and says so", async () => {
    const err = await waitForNetwork([probe("p", () => null)], {
      timeoutMs: 2_000,
      stableMs: 5_000,
      intervalMs: 1_000,
      ...fakeClock(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkNotSettledError);
    expect((err as Error).message).toContain("every probe passed, but not for 5000 ms in a row");
  });

  test("names what failed last when the probes recover too late", async () => {
    let n = 0;
    const p = probe("chat-2 /readyz", () => (++n <= 2 ? "exit 1: 503" : null));
    const err = await waitForNetwork([p], {
      timeoutMs: 3_000,
      stableMs: 5_000,
      intervalMs: 1_000,
      ...fakeClock(),
    }).catch((e: unknown) => e);
    expect((err as NetworkNotSettledError).failing).toEqual([{ name: "chat-2 /readyz", reason: "exit 1: 503" }]);
  });

  test("an aborted signal stops the wait", async () => {
    const ac = new AbortController();
    ac.abort(new Error("scenario timed out"));
    await expect(
      waitForNetwork([probe("p", () => "down")], { timeoutMs: 60_000, signal: ac.signal, ...fakeClock() }),
    ).rejects.toThrow("scenario timed out");
  });

  test("a probe that throws counts as failing, with its message", async () => {
    const failing = await failingProbes([
      probe("boom", () => {
        throw new Error("spawn failed");
      }),
      probe("str", () => Promise.reject("plain")),
      probe("ok", () => null),
    ]);
    expect(failing).toEqual([
      { name: "boom", reason: "spawn failed" },
      { name: "str", reason: "plain" },
    ]);
  });
});

describe("cross-container probes", () => {
  const result = (code: number, stdout = "", stderr = ""): PodmanResult => ({ code, stdout, stderr });

  test("readinessProbe runs the image's healthcheck URL inside the container and reports the body", async () => {
    const seen: [string, readonly string[]][] = [];
    const exec: Exec = async (c, argv) => {
      seen.push([c, argv]);
      return result(1, '503 {"ok":false,"checks":{"mediamtx":"fail","postgres":"ok"}}\n');
    };
    const p = readinessProbe("commonair_media_1", "media", exec);
    expect(p.name).toBe("commonair_media_1 /readyz");
    expect(await p.check()).toBe('exit 1: 503 {"ok":false,"checks":{"mediamtx":"fail","postgres":"ok"}}');
    expect(seen).toEqual([["commonair_media_1", ["bun", "-e", readyzScript("media")]]]);
    expect(readyzScript("media")).toContain('healthUrl("media",process.env)');
  });

  test("a passing exec is null; an exec with no output reports its exit code; stderr is the fallback", async () => {
    expect(await readinessProbe("c", "api", async () => result(0, "200 {}")).check()).toBeNull();
    expect(await readinessProbe("c", "api", async () => result(125)).check()).toBe("exit 125");
    expect(await readinessProbe("c", "api", async () => result(125, "", "Error: no such container c\n")).check()).toBe(
      "exit 125: Error: no such container c",
    );
  });

  test("smtpProbe connects from the container to its SMTP host", async () => {
    let argv: readonly string[] = [];
    const p = smtpProbe("commonair_api_1", async (_c, a) => {
      argv = a;
      return result(1, "connect timed out after 3000 ms\n");
    });
    expect(p.name).toBe("commonair_api_1 → SMTP");
    expect(await p.check()).toBe("exit 1: connect timed out after 3000 ms");
    expect(argv).toEqual(["bun", "-e", SMTP_CONNECT_SCRIPT]);
    expect(SMTP_CONNECT_SCRIPT).toContain("process.env.SMTP_HOST");
  });

  test("the in-container scripts are valid JavaScript", () => {
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (body: string) => unknown;
    // Parsed, never run: they only make sense inside a service container.
    expect(() => new AsyncFunction(readyzScript("chat"))).not.toThrow();
    expect(() => new AsyncFunction(SMTP_CONNECT_SCRIPT)).not.toThrow();
  });

  const ps = [
    "commonair_postgres_1\trunning",
    "commonair_api_1\trunning",
    "commonair_api-2_1\trunning",
    "commonair_media_1\trunning",
    "commonair_chat-2_1\trunning",
    "commonair_worker-2_1\texited",
    "othersite_api_1\trunning",
  ].join("\n");
  const noExec: Exec = async () => result(0);

  test("stackProbes: the API's readiness and SMTP, media's readiness, and each restored replica", () => {
    expect(stackProbes(ps, "commonair", ["chat-2", "worker-2"], noExec).map((p) => p.name)).toEqual([
      "commonair_api_1 /readyz",
      "commonair_api_1 → SMTP",
      "commonair_chat-2_1 /readyz",
      "commonair_media_1 /readyz",
      // Listed while still down (before its restore): the wait needs it back too.
      "commonair_worker-2_1 /readyz",
    ]);
  });

  test("stackProbes: a stopped service that is not being restored is not probed", () => {
    const names = stackProbes("commonair_api_1\trunning\ncommonair_media_1\texited", "commonair", [], noExec).map(
      (p) => p.name,
    );
    expect(names).toEqual(["commonair_api_1 /readyz", "commonair_api_1 → SMTP"]);
  });

  test("stackProbes: a replica runs its base service's healthcheck", async () => {
    const scripts: string[] = [];
    const exec: Exec = async (_c, argv) => {
      scripts.push(argv[2] ?? "");
      return result(0);
    };
    const [chat2] = stackProbes("commonair_chat-2_1\trunning", "commonair", ["chat-2"], exec);
    await chat2?.check();
    expect(scripts).toEqual([readyzScript("chat")]);
  });

  test("stackProbes: no media container, no media probe; nothing running, no probes", () => {
    expect(stackProbes("commonair_api_1\trunning", "commonair", [], noExec).map((p) => p.name)).toEqual([
      "commonair_api_1 /readyz",
      "commonair_api_1 → SMTP",
    ]);
    expect(stackProbes("", "commonair", ["chat-2"], noExec)).toEqual([]);
  });

  test("parseReplicaContainers takes a wider service list", () => {
    expect(parseReplicaContainers(ps, "commonair", ["media"])).toEqual([
      { service: "media", name: "commonair_media_1", running: true },
    ]);
  });
});

describe("multi-instance settle budget", () => {
  test("the final settle wait fits the teardown reserve", () => {
    expect(SETTLE_MS).toBeLessThan(TEARDOWN_RESERVE_MS);
    expect(SETTLE_MS).toBeLessThan(SCENARIO_TIMEOUT_MS);
  });

  test("the smallest settle budget leaves room for the stable window", () => {
    expect(SETTLE_FLOOR_MS).toBeGreaterThan(DEFAULT_STABLE_MS);
    expect(SETTLE_MS).toBeGreaterThanOrEqual(SETTLE_FLOOR_MS);
  });

  test("a settle wait given only the floor succeeds when the probes recover at once", async () => {
    const ms = await waitForNetwork([probe("p", () => null)], {
      timeoutMs: SETTLE_FLOOR_MS,
      intervalMs: 1_000,
      ...fakeClock(),
    });
    expect(ms).toBeLessThanOrEqual(SETTLE_FLOOR_MS);
  });
});
