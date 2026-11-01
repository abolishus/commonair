// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A promise a scenario left behind (a `Promise.race` loser, a frame wait never awaited because an
 * assertion threw first) that rejects later must not kill the shard: CI run 41357496846 lost
 * `watch-room` and everything after it to a `twitch-import` chat wait that timed out 30 s after
 * that scenario had failed. Bun exits on an unhandled rejection, and so would the test runner, so
 * the run happens in a child process.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const HARNESS = fileURLToPath(new URL("..", import.meta.url));

const SCRIPT = `
import { createLogger } from "@commonair/observability";
import { loadHarnessEnv } from "./src/env.ts";
import { runScenarios } from "./src/runner.ts";
import { defineScenario } from "./src/scenario.ts";

const log = createLogger({ service: "harness-test", level: "fatal", write: () => undefined });
const platform = { probe: async () => null };
const leaky = defineScenario({
  name: "leaky",
  description: "leaves a frame wait behind, then fails",
  needs: [],
  run: async (ctx) => {
    // Like chat.next(...) created before an assertion that throws: nobody awaits it.
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for chat frame message")), 50));
    ctx.assert("the message was accepted", false);
  },
});
const next = defineScenario({
  name: "next",
  description: "runs while the stray rejects",
  needs: [],
  run: async () => {
    await Bun.sleep(200);
  },
});
const report = await runScenarios([leaky, next], {
  command: "run",
  profile: "default",
  env: loadHarnessEnv({}),
  log,
  platform,
  runId: "r1",
});
console.log(JSON.stringify(report.scenarios.map((s) => ({ name: s.name, status: s.status, data: s.data }))));
`;

describe("stray rejections", () => {
  test("a rejection nobody awaits is recorded, and later scenarios still run", async () => {
    const proc = Bun.spawn(["bun", "-e", SCRIPT], { cwd: HARNESS, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
    const results = JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]") as {
      name: string;
      status: string;
      data: Record<string, unknown>;
    }[];
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ["leaky", "failed"],
      ["next", "passed"],
    ]);
    // Recorded on the scenario it fired during (it may have come from an earlier one).
    expect(results[1]?.data.strayRejections).toEqual([
      expect.stringContaining("timed out waiting for chat frame message"),
    ]);
  }, 30_000);
});
