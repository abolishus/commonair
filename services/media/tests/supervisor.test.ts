// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { createLogger } from "@commonair/observability";
import { ProgressParser, toProgress, type Progress } from "../src/ffmpeg/progress.ts";
import { REDACTED } from "../src/ffmpeg/redact.ts";
import { backoffDelay, Supervisor, type ExitInfo } from "../src/ffmpeg/supervisor.ts";

const logger = createLogger({ service: "test", level: "fatal" });

describe("progress parser", () => {
  test("parses blocks split across arbitrary chunks", () => {
    const seen: Progress[] = [];
    const p = new ProgressParser((x) => seen.push(x));
    const text =
      "frame=317\nfps=32.69\nbitrate=2048.5kbits/s\ntotal_size=1048576\nout_time_us=11056122\nout_time_ms=11056122\n" +
      "dup_frames=1\ndrop_frames=2\nspeed=1.14x\nprogress=continue\nframe=318\ntotal_size=N/A\nprogress=end\n";
    for (let i = 0; i < text.length; i += 7) p.push(text.slice(i, i + 7));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      frame: 317,
      fps: 32.69,
      outTimeMs: 11056,
      totalSizeBytes: 1048576,
      bitrateKbps: 2048.5,
      dropFrames: 2,
      dupFrames: 1,
      speed: 1.14,
      end: false,
    });
    expect(seen[1]?.end).toBe(true);
    expect(seen[1]?.totalSizeBytes).toBeNull();
  });

  test("N/A values become null", () => {
    expect(toProgress({ bitrate: "N/A", out_time_us: "N/A", progress: "continue" })).toMatchObject({
      bitrateKbps: null,
      outTimeMs: null,
      dropFrames: 0,
    });
  });
});

describe("backoff", () => {
  test("doubles from the initial delay and caps", () => {
    const p = { initialMs: 1000, maxMs: 60_000 };
    expect([0, 1, 2, 3, 4, 5, 6, 7, 100].map((a) => backoffDelay(a, p))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });
});

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) resolve();
      else if (Date.now() > deadline) reject(new Error("timed out"));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

describe("Supervisor", () => {
  test("restarts a crashing process with backoff and reports the redacted last error", async () => {
    const exits: [ExitInfo, number | null][] = [];
    const progress: Progress[] = [];
    let spawns = 0;
    const s = new Supervisor({
      name: "crasher",
      binary: "/bin/sh",
      args: () => {
        spawns++;
        return [
          "-c",
          "printf 'frame=1\\nprogress=continue\\n'; echo 'failed to connect to rtmp://x/live/KEY123' >&2; exit 3",
        ];
      },
      secrets: ["KEY123"],
      logger,
      backoff: { initialMs: 20, maxMs: 40, stableAfterMs: 60_000 },
      onProgress: (p) => progress.push(p),
      onExit: (info, restartIn) => exits.push([info, restartIn]),
    });
    s.start();
    await waitFor(() => exits.length >= 3);
    await s.stop();
    expect(spawns).toBeGreaterThanOrEqual(3);
    expect(exits[0]?.[0].code).toBe(3);
    expect(exits[0]?.[0].lastError).toBe(`failed to connect to rtmp://x/live/${REDACTED}`);
    expect(exits.slice(0, 3).map(([, d]) => d)).toEqual([20, 40, 40]);
    expect(progress[0]?.frame).toBe(1);
    expect(s.lastError).not.toContain("KEY123");
  });

  test("stop() interrupts a long-running process and does not restart it", async () => {
    const exits: (number | null)[] = [];
    const s = new Supervisor({
      name: "sleeper",
      binary: "/bin/sh",
      args: () => ["-c", "trap 'exit 0' INT; while true; do sleep 0.05; done"],
      logger,
      onExit: (_info, restartIn) => exits.push(restartIn),
      stopGraceMs: 2000,
    });
    s.start();
    await waitFor(() => s.running);
    const started = Date.now();
    await s.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(s.running).toBe(false);
    expect(exits).toEqual([null]);
  });

  test("a process ignoring SIGINT is killed after the grace period", async () => {
    const s = new Supervisor({
      name: "stubborn",
      binary: "/bin/sh",
      args: () => ["-c", "trap '' INT; while true; do sleep 0.05; done"],
      logger,
      stopGraceMs: 200,
    });
    s.start();
    await waitFor(() => s.running);
    await s.stop();
    expect(s.running).toBe(false);
  });

  test("a missing binary is reported as an exit and retried, not thrown", async () => {
    const exits: ExitInfo[] = [];
    const s = new Supervisor({
      name: "missing",
      binary: "/nonexistent/ffmpeg",
      args: () => [],
      logger,
      backoff: { initialMs: 10, maxMs: 10, stableAfterMs: 1000 },
      onExit: (info) => exits.push(info),
    });
    s.start();
    await waitFor(() => exits.length >= 2);
    await s.stop();
    expect(exits[0]?.code).toBeNull();
    expect(exits[0]?.lastError).toBeTruthy();
  });
});
