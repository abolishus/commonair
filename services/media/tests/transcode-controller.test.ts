// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The ladder's advertise and withdraw writes (Valkey key, `transcode_active`, renditions event):
 * their order, and that a late advertise cannot land after a withdraw. ffmpeg is a script that
 * reports one frame and runs until SIGINT; Valkey, the database and the bus are recording fakes.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { KEYS, type LiveEvent } from "@commonair/contracts/internal";
import { createLogger } from "@commonair/observability";
import type { BroadcastInfo, MediaContext } from "../src/context.ts";
import { MtxPath } from "../src/mediamtx.ts";
import { VIEWER_FRESH_MS } from "../src/settings.ts";
import { readViewerCount, TranscodeController } from "../src/transcode/controller.ts";
import { SlotLimiter } from "../src/transcode/slots.ts";

const dir = mkdtempSync(join(tmpdir(), "transcode-controller-"));
const fakeFfmpeg = join(dir, "ffmpeg");
writeFileSync(
  fakeFfmpeg,
  `#!/bin/sh\ntrap 'exit 0' INT\nprintf 'frame=1\\nprogress=continue\\n'\nwhile true; do sleep 0.05; done\n`,
);
chmodSync(fakeFfmpeg, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const b = { broadcastId: "b1", channelId: "c1", slug: "alice", path: "live/alice" } as BroadcastInfo;
const START_AFTER = 1_000;

/** A gate a fake write waits on until the test opens it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

function setup() {
  const keys = new Map<string, string>();
  /** Every write, in the order it completed. */
  const ops: string[] = [];
  const events: LiveEvent[] = [];
  let flag: boolean | null = null;
  /** Holds the next database write of that value until opened. */
  const holds = new Map<boolean, Promise<void>>();
  const db = {
    update: () => ({
      set: (v: { transcodeActive: boolean }) => ({
        where: async () => {
          const hold = holds.get(v.transcodeActive);
          holds.delete(v.transcodeActive);
          if (hold) await hold;
          flag = v.transcodeActive;
          ops.push(`db:${v.transcodeActive}`);
        },
      }),
    }),
  };
  const valkey = {
    get: async (k: string) => keys.get(k) ?? null,
    zcount: async () => 0,
    set: async (k: string, v: string) => {
      keys.set(k, v);
      ops.push("valkey:set");
    },
    del: async (k: string) => {
      keys.delete(k);
      ops.push("valkey:del");
    },
    expire: async () => 1,
  };
  const ctx = {
    db,
    valkey,
    publishLive: async (e: LiveEvent) => {
      events.push(e);
      if (e.type === "renditions") ops.push(`event:${e.renditions.join(",")}`);
    },
    mtx: {
      getPath: async () =>
        MtxPath.parse({
          name: b.path,
          ready: true,
          tracks: ["H264", "MPEG-4 Audio"],
          tracks2: [{ codec: "H264", codecProps: { width: 1280, height: 720 } }, { codec: "MPEG-4 Audio" }],
        }),
    },
    logger: createLogger({ service: "test", level: "fatal" }),
    timings: { transcodePollMs: 60_000, transcodeStartAfterMs: START_AFTER, transcodeStopAfterMs: 2_000 },
    transcodeThreshold: 2,
    transcodeSlots: new SlotLimiter(1),
    rtspPublishBase: "rtsp://127.0.0.1:18554",
    srtBase: "srt://127.0.0.1:8890",
    internalSecret: "s",
    caps: { encoder: "libx264" },
    clock: { w0: async () => 1_000_000 },
    ffmpeg: fakeFfmpeg,
  } as unknown as MediaContext;
  keys.set(KEYS.viewerCount(b.channelId), "5");
  const controller = new TranscodeController(ctx, b);
  return {
    controller,
    keys,
    ops,
    events,
    flag: () => flag,
    hold: (value: boolean) => {
      const g = gate();
      holds.set(value, g.wait);
      return g.open;
    },
    lastRenditions: () => {
      const last = events.filter((e) => e.type === "renditions").pop();
      return last?.type === "renditions" ? last.renditions : null;
    },
  };
}

async function until(what: string, ok: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Two polls above the threshold, START_AFTER apart: the ladder starts. */
async function startLadder(c: TranscodeController): Promise<void> {
  const t0 = 1_000_000;
  await c.tick(t0);
  await c.tick(t0 + START_AFTER);
  expect(c.active).toBe(true);
}

describe("TranscodeController writes", () => {
  test("advertise: key, then flag, then event; withdraw: key, then flag, then the source event", async () => {
    const s = setup();
    await startLadder(s.controller);
    await until("renditions advertised", () => s.lastRenditions() !== null);
    expect(s.ops).toEqual(["valkey:set", "db:true", "event:source,720p,480p,audio"]);
    expect(s.flag()).toBe(true);

    // A slow flag write: the key is already gone while the flag is still set, so a reader that
    // only watched the key reads `true` (41780221766). The event comes after the flag.
    const open = s.hold(false);
    const stopping = s.controller.stop();
    await until("key withdrawn", () => !s.keys.has(KEYS.renditions(b.channelId)));
    expect(s.flag()).toBe(true);
    expect(s.lastRenditions()).not.toEqual(["source"]);
    open();
    await stopping;
    expect(s.flag()).toBe(false);
    expect(s.lastRenditions()).toEqual(["source"]);
    const withdrawn = s.ops.slice(3);
    expect(withdrawn.indexOf("valkey:del")).toBeLessThan(withdrawn.indexOf("db:false"));
    expect(withdrawn.indexOf("db:false")).toBeLessThan(withdrawn.indexOf("event:source"));
    // One source event, however many withdraws ran (onExit and stop both withdraw).
    expect(withdrawn.filter((o) => o === "event:source")).toHaveLength(1);
  });

  test("an advertise still writing when the ladder stops cannot set the flag after the withdraw", async () => {
    const s = setup();
    const open = s.hold(true);
    await startLadder(s.controller);
    // The first frame came: the key is set, the flag write is in flight.
    await until("key advertised", () => s.keys.has(KEYS.renditions(b.channelId)));
    const stopping = s.controller.stop();
    // ffmpeg has exited and both withdraws are queued behind the advertise.
    await Bun.sleep(200);
    open();
    await stopping;
    expect(s.flag()).toBe(false);
    expect(s.keys.has(KEYS.renditions(b.channelId))).toBe(false);
    expect(s.lastRenditions()).toEqual(["source"]);
    expect(s.ops.indexOf("db:true")).toBeLessThan(s.ops.lastIndexOf("db:false"));
    expect(s.ops.at(-1)).toBe("db:false");
  });

  test("start withdraws silently: a previous process's flag is cleared, no event", async () => {
    const s = setup();
    s.keys.set(KEYS.renditions(b.channelId), '["source","720p"]');
    await s.controller.start();
    expect(s.keys.has(KEYS.renditions(b.channelId))).toBe(false);
    expect(s.flag()).toBe(false);
    expect(s.events).toEqual([]);
    await s.controller.stop();
  });
});

describe("readViewerCount", () => {
  function valkey(cached: string | null, fresh: number) {
    const calls: [number, string][] = [];
    return {
      calls,
      v: {
        get: async () => cached,
        zcount: async (_k: string, min: number, max: string) => {
          calls.push([min, max]);
          return fresh;
        },
      } as never,
    };
  }

  test("the integrity pipeline's cached count wins", async () => {
    const { v, calls } = valkey("7", 3);
    expect(await readViewerCount(v, "c", 10_000)).toBe(7);
    expect(calls).toEqual([]);
    expect(await readViewerCount(valkey("0", 3).v, "c")).toBe(0);
  });

  test("no cached count, or a malformed one: heartbeats fresher than VIEWER_FRESH_MS", async () => {
    for (const cached of [null, "x", "-1"]) {
      const { v, calls } = valkey(cached, 3);
      expect(await readViewerCount(v, "c", 100_000)).toBe(3);
      expect(calls).toEqual([[100_000 - VIEWER_FRESH_MS, "+inf"]]);
    }
  });
});
