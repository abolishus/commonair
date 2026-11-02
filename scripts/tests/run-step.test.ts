// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  type ContainerRow,
  STALE_TEST_MS,
  type TestResource,
  crashLooping,
  foreignContainers,
  podmanDesktopRunning,
  CAPTIONS_OVERRIDE,
  HARNESS_OVERRIDES,
  SEED_ENV_KEYS,
  SEED_OVERRIDE,
  W3_OVERRIDES,
  missingSeedEnv,
  stackFiles,
  stackProfiles,
  staleImageContainers,
  staleTestResources,
} from "../infra.ts";
import { runStep } from "../run-step.ts";
import { ownedProjectName, pidAlive, TEST_OWNER_LABEL, testOwnerArgs, testOwnerPid } from "../test-owner.ts";

const quiet = { stdio: "ignore" as const, log: () => {} };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runStep", () => {
  test("passes through success and failure exit codes", async () => {
    expect(await runStep(["true"], { timeoutMs: 10_000, ...quiet })).toMatchObject({ ok: true, timedOut: false });
    const r = await runStep(["sh", "-c", "exit 3"], { timeoutMs: 10_000, ...quiet });
    expect(r).toMatchObject({ ok: false, timedOut: false, exitCode: 3 });
  });

  test("logFile gets stdout and stderr in the order they were written", async () => {
    const logFile = `${process.env.TMPDIR ?? "/tmp"}/run-step-${crypto.randomUUID()}.log`;
    const r = await runStep(["sh", "-c", "echo one; echo two >&2; echo three"], {
      timeoutMs: 10_000,
      logFile,
      log: () => {},
    });
    expect(r.ok).toBe(true);
    expect(await Bun.file(logFile).text()).toBe("one\ntwo\nthree\n");
  });

  test("an abort kills the step and reports it cancelled, not failed by its own doing", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const r = await runStep(["sleep", "30"], { timeoutMs: 10_000, signal: abort.signal, ...quiet });
    expect(r).toMatchObject({ ok: false, cancelled: true, timedOut: false });
    expect(r.ms).toBeLessThan(5_000);
    const late = await runStep(["true"], { timeoutMs: 10_000, signal: abort.signal, ...quiet });
    expect(late).toMatchObject({ ok: false, cancelled: true, exitCode: null });
  });

  test("a step past its deadline fails as timed out", async () => {
    const r = await runStep(["sleep", "30"], { timeoutMs: 200, killGraceMs: 200, ...quiet });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeLessThan(5_000);
  });

  test("a timeout kills grandchildren, not just the direct child", async () => {
    const pidFile = `${process.env.TMPDIR ?? "/tmp"}/run-step-${crypto.randomUUID()}.pid`;
    // The shell ignores SIGTERM, so only the group-wide SIGKILL after the grace period stops it.
    const script = `trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`;
    const r = await runStep(["sh", "-c", script], { timeoutMs: 300, killGraceMs: 200, ...quiet });
    expect(r.timedOut).toBe(true);
    const grandchild = Number(await Bun.file(pidFile).text());
    await Bun.sleep(100);
    expect(alive(grandchild)).toBe(false);
  });

  test("children left behind by a finished step are reaped", async () => {
    const pidFile = `${process.env.TMPDIR ?? "/tmp"}/run-step-${crypto.randomUUID()}.pid`;
    const r = await runStep(["sh", "-c", `sleep 30 & echo $! > ${pidFile}`], { timeoutMs: 10_000, ...quiet });
    expect(r.ok).toBe(true);
    const orphan = Number(await Bun.file(pidFile).text());
    await Bun.sleep(100);
    expect(alive(orphan)).toBe(false);
  });

  test("heartbeat reports a long step", async () => {
    const lines: string[] = [];
    await runStep(["sleep", "0.35"], {
      timeoutMs: 10_000,
      heartbeatMs: 100,
      stdio: "ignore",
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes("still running"))).toBe(true);
  });
});

const row = (over: Partial<ContainerRow>): ContainerRow => ({
  name: "commonair_garage_1",
  service: "garage",
  workingDir: "/Users/me/bcon",
  status: "running",
  restarts: 0,
  ...over,
});

describe("foreignContainers", () => {
  test("flags containers created from another checkout", () => {
    const rows = [row({}), row({ service: "valkey", workingDir: "/Users/me/bcon/.claude/worktrees/agent-1" })];
    expect(foreignContainers(rows, "/Users/me/bcon").map((r) => r.service)).toEqual(["valkey"]);
  });

  test("treats /private/tmp and /tmp, and a trailing slash, as the same path", () => {
    expect(foreignContainers([row({ workingDir: "/private/tmp/x" })], "/tmp/x/")).toEqual([]);
  });

  test("ignores containers without a working-dir label", () => {
    expect(foreignContainers([row({ workingDir: "" })], "/Users/me/bcon")).toEqual([]);
  });
});

describe("crashLooping", () => {
  test("flags a service at the restart threshold, not below it", () => {
    expect(crashLooping([row({ restarts: 2 })])).toEqual([]);
    expect(crashLooping([row({ restarts: 3, status: "exited" })])).toHaveLength(1);
  });
});

describe("staleTestResources", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const old = now - STALE_TEST_MS - 1;
  const res = (name: string, createdMs = old, kind: TestResource["kind"] = "container"): TestResource => ({
    kind,
    name,
    createdMs,
  });

  test("selects old throwaway test containers, compose projects, volumes and networks", () => {
    const rows = [
      res("media-int-garage-a00d662b"),
      res("media-int-mtx-e5c3f33f"),
      res("media-int-target-ae031e9f"),
      res("harness-mediamtx-2a9ddb70"),
      res("origin-test-68a93d4a"),
      res("commonair-it-783005c5_postgres_1"),
      res("commonair-it-783005c5-restore"),
      res("commonair-it-783005c5_postgres-data", old, "volume"),
      res("commonair-it-783005c5_default", old, "network"),
    ];
    expect(staleTestResources(rows, now)).toEqual(rows);
  });

  test("keeps anything younger than the cutoff: another checkout may be mid-run", () => {
    expect(staleTestResources([res("media-int-mtx-e5c3f33f", now - STALE_TEST_MS + 1)], now)).toEqual([]);
  });

  test("never touches the dev stack or unrelated containers", () => {
    const rows = [
      res("commonair_postgres_1"),
      res("commonair_postgres-data", old, "volume"),
      res("commonair_default", old, "network"),
      res("commonair-it-783005c5"),
      res("media-int-mtx-notahex1"),
      res("my-media-int-mtx-e5c3f33f"),
      res("podman", old, "network"),
    ];
    expect(staleTestResources(rows, now)).toEqual([]);
  });

  test("an unknown creation time is never stale", () => {
    expect(staleTestResources([res("origin-test-68a93d4a", Number.NaN)], now)).toEqual([]);
  });

  test("covers every name the integration tests use", () => {
    const rows = [
      res("harness-mediamtx-ff-2a9ddb70"),
      res("media-int-clockw-2a9ddb70"),
      res("media-int-clockff-2a9ddb70"),
      res("commonair-pgh-primary-2a9ddb70"),
      res("commonair-pgh-2a9ddb70", old, "volume"),
      res("commonair-it-4242-783005c5_postgres_1"),
    ];
    expect(staleTestResources(rows, now)).toEqual(rows);
  });

  describe("owner labels", () => {
    const dead = new Set([111, 333]);
    const alive = (pid: number) => !dead.has(pid);
    const owned = (name: string, labels: Record<string, string>, kind: TestResource["kind"] = "container") => ({
      ...res(name, now, kind),
      labels,
    });

    test("removes a fresh resource as soon as its owner is gone, of any kind or name", () => {
      const rows = [
        owned("wizardly_turing", { [TEST_OWNER_LABEL]: "111" }),
        owned("commonair-pgh-2a9ddb70", { [TEST_OWNER_LABEL]: "111" }, "volume"),
        owned("sha256:abc", { [TEST_OWNER_LABEL]: "333" }, "image"),
        owned(
          "commonair-it-333-783005c5_default",
          { "com.docker.compose.project": "commonair-it-333-783005c5" },
          "network",
        ),
      ];
      expect(staleTestResources(rows, now, alive)).toEqual(rows);
    });

    test("keeps anything whose owner is alive, however old", () => {
      const rows = [
        { ...owned("media-int-mtx-e5c3f33f", { [TEST_OWNER_LABEL]: "222" }), createdMs: old },
        owned("commonair-it-222-783005c5_postgres_1", { "com.docker.compose.project": "commonair-it-222-783005c5" }),
      ];
      expect(staleTestResources(rows, now, alive)).toEqual([]);
    });

    test("ignores labels that name no owner, and unlabelled images", () => {
      const rows = [
        owned("commonair_postgres_1", { "com.docker.compose.project": "commonair" }),
        owned("commonair-it-783005c5_postgres_1", { "com.docker.compose.project": "commonair-it-783005c5" }),
        owned("x", { [TEST_OWNER_LABEL]: "" }),
        owned("y", { [TEST_OWNER_LABEL]: "0" }),
        owned("z", { [TEST_OWNER_LABEL]: "12a" }),
        res("media-int-mtx-e5c3f33f", old, "image"),
      ];
      expect(staleTestResources(rows, now, () => false)).toEqual([]);
    });
  });
});

describe("podmanDesktopRunning", () => {
  test("spots the app's main process", () => {
    expect(
      podmanDesktopRunning("/usr/sbin/cfprefsd\n/Applications/Podman Desktop.app/Contents/MacOS/Podman Desktop\n"),
    ).toBe(true);
  });

  test("ignores its helpers, the podman machine and everything else", () => {
    const ps = [
      "/Applications/Podman Desktop.app/Contents/Frameworks/Podman Desktop Helper (Renderer).app/Contents/MacOS/Podman Desktop Helper (Renderer)",
      "/opt/homebrew/Cellar/podman/6.1.4/libexec/podman/gvproxy",
      "/opt/homebrew/Cellar/podman/6.1.4/libexec/podman/vfkit",
      "",
    ].join("\n");
    expect(podmanDesktopRunning(ps)).toBe(false);
  });
});

describe("test-owner", () => {
  test("pidAlive tells a running process from an exited one", async () => {
    expect(pidAlive(process.pid)).toBe(true);
    const child = Bun.spawn(["true"]);
    await child.exited;
    expect(pidAlive(child.pid)).toBe(false);
  });

  test("testOwnerArgs labels with the pid", () => {
    expect(testOwnerArgs(4242)).toEqual(["--label", `${TEST_OWNER_LABEL}=4242`]);
  });

  test("ownedProjectName round-trips through testOwnerPid", () => {
    const name = ownedProjectName("commonair-it", 4242);
    expect(name).toMatch(/^commonair-it-4242-[0-9a-f]{8}$/);
    expect(testOwnerPid({ "com.docker.compose.project": name })).toBe(4242);
  });

  test("testOwnerPid prefers the owner label and tolerates missing labels", () => {
    expect(testOwnerPid({ [TEST_OWNER_LABEL]: "7", "com.docker.compose.project": "commonair-it-9-783005c5" })).toBe(7);
    expect(testOwnerPid(null)).toBeUndefined();
    expect(testOwnerPid(undefined)).toBeUndefined();
    expect(testOwnerPid({})).toBeUndefined();
  });
});

describe("stackFiles", () => {
  test("the plain stack passes no -f, so compose picks compose.yaml itself", () => {
    expect(stackFiles([])).toEqual([]);
  });

  test("overrides are layered over compose.yaml, by absolute path", () => {
    const args = stackFiles(["harness/compose.trust-safety.yaml"]);
    expect(args.filter((a) => a === "-f")).toHaveLength(2);
    expect(args[1]).toMatch(/\/compose\.yaml$/);
    expect(args[3]).toMatch(/\/harness\/compose\.trust-safety\.yaml$/);
  });

  test("--harness layers every harness override, then any extra file", () => {
    const files = stackFiles(["--harness"]).filter((a) => a !== "-f");
    expect(files).toHaveLength(1 + HARNESS_OVERRIDES.length);
    expect(files.slice(1).map((f) => f.slice(f.indexOf("/harness/") + 1))).toEqual([...HARNESS_OVERRIDES]);
    expect(stackFiles(["harness/compose.e6.yaml", "--harness"]).filter((a) => a === "-f")).toHaveLength(
      2 + HARNESS_OVERRIDES.length,
    );
  });

  test("--multi adds the multi profile, only on top of --harness, and is not a file", () => {
    expect(stackProfiles(["--harness"])).toEqual(["harness"]);
    expect(stackProfiles(["--harness", "--multi"])).toEqual(["harness", "multi"]);
    expect(() => stackProfiles(["--multi"])).toThrow(/needs --harness/);
    expect(stackFiles(["--harness", "--multi"])).toEqual(stackFiles(["--harness"]));
    expect(HARNESS_OVERRIDES).not.toContain(CAPTIONS_OVERRIDE);
  });

  test("--captions layers the captions override last and enables its profile, with --harness only", () => {
    expect(stackProfiles(["--harness", "--captions"])).toEqual(["harness", "captions"]);
    expect(stackProfiles(["--harness", "--multi", "--captions"])).toEqual(["harness", "multi", "captions"]);
    expect(() => stackProfiles(["--captions"])).toThrow(/needs --harness/);
    const files = stackFiles(["--harness", "--captions"]).filter((a) => a !== "-f");
    expect(files).toHaveLength(2 + HARNESS_OVERRIDES.length);
    expect(files.at(-1)?.endsWith(CAPTIONS_OVERRIDE)).toBe(true);
    expect(stackFiles(["--harness"]).some((f) => f.endsWith(CAPTIONS_OVERRIDE))).toBe(false);
    expect(HARNESS_OVERRIDES).toContain("harness/compose.multi-instance.yaml");
  });

  // Batch 7 decision (d): giveaways, the Twitch mock and federation only on the w3 and interact shards.
  test("--w3 layers the batch 7 overrides after the harness ones (and captions), with --harness only", () => {
    const tail = (args: string[]) => args.filter((a) => a !== "-f").map((f) => f.slice(f.indexOf("/harness/") + 1));
    const files = tail(stackFiles(["--harness", "--w3"]));
    expect(files).toHaveLength(1 + HARNESS_OVERRIDES.length + W3_OVERRIDES.length);
    expect(files.slice(1)).toEqual([...HARNESS_OVERRIDES, ...W3_OVERRIDES]);
    expect(tail(stackFiles(["--harness", "--multi", "--captions", "--w3"])).slice(1)).toEqual([
      ...HARNESS_OVERRIDES,
      CAPTIONS_OVERRIDE,
      ...W3_OVERRIDES,
    ]);
    // The overrides also set the multi replicas' environment: the multi override comes first.
    expect(files.indexOf("harness/compose.multi-instance.yaml")).toBeLessThan(files.indexOf(W3_OVERRIDES[0]));
    expect(stackProfiles(["--harness", "--multi", "--w3"])).toEqual(["harness", "multi"]);
    for (const f of W3_OVERRIDES) {
      expect(HARNESS_OVERRIDES as readonly string[]).not.toContain(f);
      expect(stackFiles(["--harness"]).some((a) => a.endsWith(f))).toBe(false);
    }
    expect(() => stackFiles(["--w3"])).toThrow(/--w3 needs --harness/);
    expect(() => stackFiles(["harness/compose.n4.yaml"])).toThrow(/--harness --w3/);
    expect(() => stackFiles(["--harness", "harness/compose.w3.yaml"])).toThrow(/--harness --w3/);
  });

  // seed-full decision (e): the seed fills every feature's tables, so it needs every override.
  test("--seed layers the seed override last and stripe-mock, only on the whole harness stack", () => {
    const tail = (args: string[]) => args.filter((a) => a !== "-f").map((f) => f.slice(f.indexOf("/harness/") + 1));
    const all = ["--harness", "--multi", "--captions", "--w3", "--seed"];
    expect(tail(stackFiles(all)).slice(1)).toEqual([
      ...HARNESS_OVERRIDES,
      CAPTIONS_OVERRIDE,
      ...W3_OVERRIDES,
      SEED_OVERRIDE,
    ]);
    expect(stackProfiles(all)).toEqual(["harness", "multi", "captions", "stripe"]);
    expect(stackFiles(["--harness", "--multi", "--captions", "--w3"]).some((a) => a.endsWith(SEED_OVERRIDE))).toBe(
      false,
    );
    expect(() => stackFiles(["--harness", "--seed"])).toThrow(/--seed needs --harness --captions --w3/);
    expect(() => stackFiles(["--harness", "--w3", "--seed"])).toThrow(/--seed needs/);
    expect(() => stackProfiles(["--seed"])).toThrow(/--seed needs --harness/);
    expect(() => stackFiles(["--harness", SEED_OVERRIDE])).toThrow(/layer it with --seed/);
  });

  test("missingSeedEnv names the generated keys an env file leaves empty", () => {
    expect(missingSeedEnv("")).toEqual([...SEED_ENV_KEYS]);
    const full = SEED_ENV_KEYS.map((k) => `${k}=x`).join("\n");
    expect(missingSeedEnv(full)).toEqual([]);
    expect(missingSeedEnv(`${full}\nSTRIPE_WEBHOOK_SECRET=  `)).toEqual(["STRIPE_WEBHOOK_SECRET"]);
    expect(missingSeedEnv(full.replace("INTEGRITY_SIGNING_KEY=x", "INTEGRITY_SIGNING_KEY="))).toEqual([
      "INTEGRITY_SIGNING_KEY",
    ]);
  });

  test("refuses a missing file or an option instead of starting the wrong stack", () => {
    expect(() => stackFiles(["nope.yaml"])).toThrow(/not found/);
    expect(() => stackFiles(["--build"])).toThrow(/unknown option/);
  });
});

describe("staleImageContainers", () => {
  const current = new Map([
    ["localhost/commonair/api:dev", "b8c024aae97d8e2a244d"],
    ["docker.io/dxflrs/garage:v2.4.1", "2711bbf081dcffff"],
  ]);

  test("a container whose tag now points at a newer build is stale", () => {
    const rows = [{ name: "commonair_api_1", imageId: "0123456789ab", image: "localhost/commonair/api:dev" }];
    expect(staleImageContainers(rows, current)).toEqual(rows);
  });

  test("current containers, unknown images and missing ids are left alone", () => {
    const rows = [
      { name: "commonair_api_1", imageId: "b8c024aae97d", image: "localhost/commonair/api:dev" },
      { name: "commonair_garage_1", imageId: "2711bbf081dc", image: "docker.io/dxflrs/garage:v2.4.1" },
      { name: "commonair_web_1", imageId: "aaaaaaaaaaaa", image: "localhost/commonair/web:dev" },
      { name: "commonair_x_1", imageId: "", image: "localhost/commonair/api:dev" },
    ];
    expect(staleImageContainers(rows, current)).toEqual([]);
  });
});
