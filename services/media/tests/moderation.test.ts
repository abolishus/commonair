// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media moderation without unit A's primitives: synthetic byte frames, a fake PDQ that reads a
 * planted hash, and a fake queue. No image of anything is involved.
 */
import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModerationT0Job } from "@commonair/contracts/internal";
import { HashListParseError, plaintextSha256, type HashList } from "@commonair/moderation";
import { loadLists, type ListTools } from "../src/moderation/lists.ts";
import { LiveSampler, liveFrameArgs, type SamplerClock } from "../src/moderation/sampler.ts";
import { setupModeration } from "../src/moderation/setup.ts";
import { T0Outbox } from "../src/moderation/t0-outbox.ts";
import { SegmentRecorder } from "../src/vod/recorder.ts";
import type { MediaContext } from "../src/context.ts";
import type { Database } from "@commonair/db";
import { ActiveScratch, recoverWorkDir, sweepScratchAtStartup, sweepWorkDir } from "../src/recovery.ts";
import { BroadcastSession } from "../src/session.ts";
import { scanChunks } from "../src/vod/finalize.ts";
import type { PlaylistSegment } from "../src/vod/playlist.ts";
import {
  captureLogger,
  fakeFrame,
  fakeMatcher,
  fakeTools,
  FakeQueue,
  makeModeration,
  stubDb,
  testKeys,
} from "./helpers/moderation.ts";

const MATCH = "a".repeat(64);
const target = {
  broadcastId: "0192a1b2-0000-7000-8000-000000000001",
  channelId: "0192a1b2-0000-7000-8000-000000000002",
  path: "live/someone",
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A manual clock: timers fire only when the test advances time. */
class ManualClock implements SamplerClock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  async advance(ms: number) {
    const end = this.t + ms;
    await flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flush();
    }
    this.t = end;
  }
}

describe("live sampling schedule", () => {
  test("first frame at once, then every interval; a setting change applies from the next wait", async () => {
    const clock = new ManualClock();
    const at: number[] = [];
    let interval = 10;
    const s = new LiveSampler({
      capture: async () => {
        at.push(clock.now());
        return fakeFrame("0", 80);
      },
      scan: async () => "clean",
      intervalSeconds: async () => interval,
      logger: captureLogger().logger,
      clock,
    });
    s.start();
    await clock.advance(0);
    expect(at).toEqual([0]);
    await clock.advance(25_000);
    expect(at).toEqual([0, 10_000, 20_000]);
    interval = 5;
    await clock.advance(15_000);
    // The wait after the 20 s sample was already 10 s; the one after 30 s reads 5 s.
    expect(at).toEqual([0, 10_000, 20_000, 30_000, 35_000, 40_000]);
    await s.stop();
    await clock.advance(60_000);
    expect(at).toHaveLength(6);
  });

  test("the first sample lands within STREAM_START_SAMPLE_SECONDS even if the first captures fail", async () => {
    const clock = new ManualClock();
    let calls = 0;
    const ok: number[] = [];
    let failures = 0;
    const s = new LiveSampler({
      capture: async () => {
        if (++calls <= 2) throw new Error("no keyframe yet");
        ok.push(clock.now());
        return fakeFrame("0", 80);
      },
      scan: async () => "clean",
      intervalSeconds: async () => 10,
      onCaptureFailed: () => failures++,
      logger: captureLogger().logger,
      clock,
    });
    s.start();
    await clock.advance(3_000);
    expect(ok[0]).toBeLessThanOrEqual(3_000);
    expect(failures).toBe(2);
    await s.stop();
  });

  test("the effective interval is min(env, setting); an invalid setting means the defaults", async () => {
    const cases: [number, unknown, number][] = [
      [10, undefined, 10],
      [2, undefined, 2],
      [
        30,
        {
          t1: { sexual: 0.97, graphic_violence: 0.9, weapons: 0.95, self_harm: 0.9 },
          t2: { sexual: 0.8 },
          sampleSeconds: 5,
        },
        5,
      ],
      [60, { t1: {}, t2: {}, sampleSeconds: 999 }, 10],
    ];
    for (const [env, setting, expected] of cases) {
      const { moderation } = await makeModeration({ envSampleSeconds: env, db: stubDb({ setting }) });
      expect(await moderation.sampleSeconds()).toBe(expected);
    }
    // An unreadable setting never stops sampling: the env value is used.
    const { moderation } = await makeModeration({ envSampleSeconds: 7, db: stubDb({ fail: true }) });
    expect(await moderation.sampleSeconds()).toBe(7);
  });

  test("off air within two sample intervals of the first matching frame", async () => {
    const clock = new ManualClock();
    const { moderation, kicks } = await makeModeration({
      matcher: fakeMatcher({ [MATCH]: "csam" }),
      now: () => new Date(clock.now()),
    });
    const INTERVAL = 10;
    const MATCH_FROM = 23_456;
    const s = new LiveSampler({
      capture: async () => (clock.now() >= MATCH_FROM ? fakeFrame("a", 90) : fakeFrame("1", 90)),
      scan: (f, t) => moderation.scanLiveFrame(target, f, t),
      intervalSeconds: async () => INTERVAL,
      logger: captureLogger().logger,
      clock,
    });
    s.start();
    let kickedAt: number | null = null;
    for (let i = 0; i < 100 && kickedAt === null; i++) {
      await clock.advance(500);
      if (kicks.length > 0) kickedAt = clock.now();
    }
    expect(kickedAt).not.toBeNull();
    expect((kickedAt ?? 0) - MATCH_FROM).toBeLessThanOrEqual(2 * INTERVAL * 1000);
    await s.stop();
    await moderation.settle();
  });
});

describe("live frames", () => {
  test("a clean frame goes to Valkey with the TTL and a scan job; nothing else is stored", async () => {
    const sets: { key: string; ttl: number; size: number }[] = [];
    const { moderation, queue } = await makeModeration({
      valkey: {
        set: async (key, value, _m, ttl) => {
          sets.push({ key, ttl, size: value.byteLength });
          return "OK";
        },
      },
    });
    expect(await moderation.scanLiveFrame(target, fakeFrame("1", 90), new Date())).toBe("clean");
    expect(queue.scans).toHaveLength(1);
    const job = queue.scans[0];
    expect(job).toMatchObject({
      broadcastId: target.broadcastId,
      channelId: target.channelId,
      pdq: "1".repeat(64),
      quality: 90,
    });
    expect(sets).toEqual([{ key: `moderation:frame:${job?.frameId}`, ttl: 60, size: 384 * 384 * 3 }]);
    expect(queue.t0s).toHaveLength(0);
  });

  test("a low-quality frame is classified but never matched, even if its hash is listed", async () => {
    const { moderation, queue, kicks } = await makeModeration({ matcher: fakeMatcher({ [MATCH]: "csam" }) });
    expect(await moderation.scanLiveFrame(target, fakeFrame("a", 49), new Date())).toBe("clean");
    expect(kicks).toEqual([]);
    expect(queue.scans[0]).toMatchObject({ pdq: null, quality: 49 });
  });

  test("a backed-up queue drops the classifier job but PDQ still runs and matches", async () => {
    const queue = new FakeQueue();
    queue.waiting = 4; // > 3 intervals × 1 live broadcast
    const { moderation, kicks } = await makeModeration({
      queue,
      db: stubDb({ liveCount: 1 }),
      matcher: fakeMatcher({ [MATCH]: "csam" }),
    });
    expect(await moderation.scanLiveFrame(target, fakeFrame("1", 90), new Date())).toBe("clean");
    expect(queue.scans).toHaveLength(0);
    expect(await moderation.scanLiveFrame(target, fakeFrame("a", 90), new Date())).toBe("matched");
    expect(kicks).toEqual([target.path]);
    await moderation.settle();
    expect(queue.t0s).toHaveLength(1);
    // At the limit (3 per live broadcast) nothing is dropped.
    queue.waiting = 6;
    const two = await makeModeration({ queue, db: stubDb({ liveCount: 2 }) });
    await two.moderation.scanLiveFrame(target, fakeFrame("1", 90), new Date());
    expect(queue.scans).toHaveLength(1);
  });
});

describe("T0 live", () => {
  test("kicks before it seals or enqueues, stops local work, and the job is a sealed ModerationT0Job", async () => {
    const { moderation, queue, events, stopped, opener } = await makeModeration({
      matcher: fakeMatcher({ [MATCH]: "ncii" }, "sha256:fixture:1"),
    });
    const frame = fakeFrame("a", 90);
    expect(await moderation.scanLiveFrame(target, frame, new Date("2026-10-21T10:00:00Z"))).toBe("matched");
    await moderation.settle();
    expect(events).toEqual(["kick", "t0"]);
    expect(stopped).toEqual([target.broadcastId]);
    expect(queue.scans).toHaveLength(0);
    const job = ModerationT0Job.parse(queue.t0s[0]);
    expect(job).toMatchObject({
      subjectType: "broadcast",
      subjectId: target.broadcastId,
      channelId: target.channelId,
      userId: null,
      listCategory: "ncii",
      provider: "pdq:operator-list",
      listVersion: "sha256:fixture:1",
      distance: 0,
      quality: 90,
      capturedAt: "2026-10-21T10:00:00.000Z",
    });
    expect(job.evidence).toHaveLength(2);
    expect(job.evidence.map((e) => [e.kind, e.contentType, e.pdq, e.pdqQuality])).toEqual([
      ["frame", "image/png", MATCH, 90],
      ["frame", "image/png", null, null],
    ]);
    const expected = [frame.luma.slice(0, 1024), frame.rgb.slice(0, 1024)];
    for (const [i, e] of job.evidence.entries()) {
      const plain = await opener.open(Buffer.from(e.sealedBase64, "base64"));
      expect(plain).toEqual(expected[i]);
      expect(e.sha256).toBe(await plaintextSha256(plain));
      expect(e.sizeBytes).toBe(plain.byteLength);
      expect(e.keyId).toBe(opener.keyId);
    }
  });

  test("sealing failure retries with the captured hit and logs only a safe error category", async () => {
    const baseTools = fakeTools();
    let encodeCalls = 0;
    const tools = fakeTools({
      encodePng: async (frame) => {
        encodeCalls++;
        if (encodeCalls === 1) throw new Error("private://evidence/object-secret");
        return baseTools.encodePng(frame);
      },
    });
    const { moderation, queue, lines, outbox } = await makeModeration({
      tools,
      matcher: fakeMatcher({ [MATCH]: "csam" }),
    });
    expect(await moderation.scanLiveFrame(target, fakeFrame("a", 90), new Date())).toBe("matched");
    await moderation.settle();
    expect(encodeCalls).toBe(2);
    expect(queue.t0s).toHaveLength(1);
    expect(queue.t0s[0]?.evidence).toHaveLength(2);
    expect(await outbox.pending()).toHaveLength(1);
    const output = lines.join("\n");
    expect(output).toContain('"error":"Error"');
    expect(output).not.toContain("private://");
    expect(output).not.toContain("object-secret");
  });

  test("the enqueue is retried until it lands, with a fatal log once it keeps failing", async () => {
    const queue = new FakeQueue();
    queue.failT0 = 6;
    const { moderation, events, lines } = await makeModeration({
      queue,
      matcher: fakeMatcher({ [MATCH]: "csam" }),
      fatalAfterAttempts: 5,
    });
    await moderation.scanLiveFrame(target, fakeFrame("a", 90), new Date());
    await moderation.settle();
    expect(events[0]).toBe("kick");
    expect(events.filter((e) => e === "t0-failed")).toHaveLength(6);
    expect(events.at(-1)).toBe("t0");
    expect(lines.filter((l) => JSON.parse(l).level === "fatal")).toHaveLength(1);
  });

  test("a failing kick keeps T0 pending until the publisher is confirmed off air", async () => {
    let calls = 0;
    const q = new FakeQueue();
    const { moderation, queue } = await makeModeration({
      queue: q,
      matcher: fakeMatcher({ [MATCH]: "csam" }),
      kickPublisher: async () => {
        calls++;
        if (calls < 4) throw new Error("mediamtx down");
      },
    });
    await moderation.scanLiveFrame(target, fakeFrame("a", 90), new Date());
    await moderation.settle();
    expect(calls).toBe(4);
    expect(queue.t0s).toHaveLength(1);
  });

  test("a tainted channel or path is refused on reconnect, and its broadcast is never published", async () => {
    const { moderation, kicks } = await makeModeration({ matcher: fakeMatcher({ [MATCH]: "csam" }) });
    expect(moderation.isLiveTainted(target.channelId, target.path)).toBe(false);
    await moderation.scanLiveFrame(target, fakeFrame("a", 90), new Date());
    await moderation.settle();
    expect(moderation.isLiveTainted(target.channelId, "live/other")).toBe(true);
    expect(moderation.isLiveTainted("0192a1b2-0000-7000-8000-00000000000f", target.path)).toBe(true);
    expect(await moderation.broadcastTainted(target.broadcastId)).toBe(true);
    moderation.refuseReconnect({ ...target, broadcastId: "0192a1b2-0000-7000-8000-000000000003" });
    await moderation.settle();
    expect(kicks).toEqual([target.path, target.path]);
  });

  test("a queued T0 job taints the broadcast after a restart", async () => {
    const queue = new FakeQueue();
    const first = await makeModeration({ queue, matcher: fakeMatcher({ [MATCH]: "csam" }) });
    await first.moderation.scanLiveFrame(target, fakeFrame("a", 90), new Date());
    await first.moderation.settle();
    const restarted = await makeModeration({ queue });
    expect(await restarted.moderation.broadcastTainted(target.broadcastId)).toBe(true);
    expect(await restarted.moderation.broadcastTainted("0192a1b2-0000-7000-8000-000000000009")).toBe(false);
  });

  test("a matching live thumbnail is T0 live with the original image sealed too", async () => {
    const { moderation, queue, kicks, opener } = await makeModeration({
      matcher: fakeMatcher({ [MATCH]: "csam" }),
    });
    // The fake decoder reads the planted nibble and quality from the first two bytes.
    const thumb = new Uint8Array([0x61, 90, 1, 2, 3]);
    expect(await moderation.checkLiveThumbnail(target, thumb, "image/webp")).toBe(true);
    await moderation.settle();
    expect(kicks).toEqual([target.path]);
    const ev = queue.t0s[0]?.evidence ?? [];
    expect(ev.map((e) => e.kind)).toEqual(["frame", "frame", "thumbnail"]);
    expect(await opener.open(Buffer.from(ev[2]?.sealedBase64 ?? "", "base64"))).toEqual(thumb);
    expect(await moderation.checkLiveThumbnail(target, new Uint8Array([0x31, 90]), "image/webp")).toBe(false);
  });

  test("logs carry ids, categories, versions and distances only", async () => {
    const queue = new FakeQueue();
    queue.failT0 = 2;
    let calls = 0;
    const { moderation, lines } = await makeModeration({
      queue,
      matcher: fakeMatcher({ [MATCH]: "csam" }),
      kickPublisher: async () => {
        calls++;
        if (calls === 1) throw new Error("kick failed for rtsp://internal:secret@127.0.0.1:8554/live/someone");
      },
    });
    await moderation.scanLiveFrame(target, fakeFrame("a", 90), new Date());
    await moderation.settle();
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(2);
    const job = queue.t0s[0];
    expect(job).toBeDefined();
    for (const e of job?.evidence ?? []) {
      expect(all).not.toContain(e.sealedBase64.slice(0, 40));
      expect(all).not.toContain(e.sha256);
    }
    expect(all).not.toContain(MATCH);
    expect(all).not.toContain("1".repeat(64));
    expect(all).not.toContain("rtsp://");
    expect(all).not.toContain("secret");
    expect(all).not.toMatch(/[A-Za-z0-9+/]{200,}/);
    expect(all).toContain('"category":"csam"');
    expect(all).toContain('"listVersion":"sha256:test:1"');
  });
});

describe("pre-publish scans", () => {
  test("every sampled frame is checked; the first match is returned with the count", async () => {
    const tools = fakeTools({
      async *sampleVideo() {
        yield { ...fakeFrame("1", 90), atSeconds: 0 };
        yield { ...fakeFrame("2", 30), atSeconds: 1 };
        yield { ...fakeFrame("a", 90), atSeconds: 2 };
        yield { ...fakeFrame("3", 90), atSeconds: 3 };
      },
    });
    const { moderation, queue, kicks } = await makeModeration({ tools, matcher: fakeMatcher({ [MATCH]: "csam" }) });
    const r = await moderation.scanVideoFile("/x.mp4", 1, new Date());
    expect(r.frames).toBe(3);
    expect(r.hit?.match.category).toBe("csam");
    await moderation.t0Prepublish("clip", "0192a1b2-0000-7000-8000-000000000004", target.channelId, r.hit!);
    expect(ModerationT0Job.parse(queue.t0s[0])).toMatchObject({ subjectType: "clip", userId: null });
    // Pre-publish matches never kick anyone or touch a live session.
    expect(kicks).toEqual([]);
  });

  test("a pre-publish enqueue retries until accepted and retains sealed evidence across restart", async () => {
    const queue = new FakeQueue();
    queue.failT0 = 3;
    const dir = await mkdtemp(join(tmpdir(), "commonair-t0-outbox-"));
    const outbox = new T0Outbox(dir);
    const { moderation } = await makeModeration({ queue, t0Outbox: outbox });
    const hit = {
      match: {
        category: "csam" as const,
        provider: "pdq:local" as const,
        listVersion: "local:1:x",
        distance: 3,
        quality: 90,
      },
      frame: fakeFrame("a", 90),
      pdq: { hash: MATCH, quality: 90 },
      capturedAt: new Date(),
    };
    await moderation.t0Prepublish("vod", "0192a1b2-0000-7000-8000-000000000005", target.channelId, hit);
    expect(queue.t0s).toHaveLength(1);
    expect(await outbox.pending()).toHaveLength(1);

    const pending = await outbox.persist({
      subjectType: "clip",
      subjectId: "0192a1b2-0000-7000-8000-000000000006",
      channelId: target.channelId,
      userId: null,
      listCategory: "csam",
      provider: "pdq:local",
      listVersion: "local:1:x",
      distance: 3,
      quality: 90,
      capturedAt: new Date().toISOString(),
      evidence: await moderation.sealHit(hit),
    });
    const afterRestart = new T0Outbox(dir);
    await sweepScratchAtStartup({ workDir: dirname(dir), logger: captureLogger().logger });
    expect((await afterRestart.pending()).map((x) => x.job.subjectId)).toContain(pending.job.subjectId);
    await rm(dir, { recursive: true, force: true });
  });

  test("a T0 outbox write failure retries without discarding the known hit", async () => {
    const base = new T0Outbox(join(tmpdir(), `commonair-t0-write-retry-${crypto.randomUUID()}`));
    let writes = 0;
    const outbox = {
      persist: async (...args: Parameters<T0Outbox["persist"]>) => {
        writes++;
        if (writes === 1) throw new Error("synthetic write failure");
        return base.persist(...args);
      },
      pending: () => base.pending(),
      accepted: (path: string) => base.accepted(path),
    } as T0Outbox;
    const queue = new FakeQueue();
    const { moderation } = await makeModeration({ queue, t0Outbox: outbox });
    const hit = {
      match: {
        category: "csam" as const,
        provider: "pdq:local" as const,
        listVersion: "local:1:x",
        distance: 3,
        quality: 90,
      },
      frame: fakeFrame("a", 90),
      pdq: { hash: MATCH, quality: 90 },
      capturedAt: new Date(),
    };
    await moderation.t0Prepublish("clip", "0192a1b2-0000-7000-8000-000000000007", target.channelId, hit);
    expect(writes).toBe(2);
    expect(queue.t0s).toHaveLength(1);
  });

  test("a decoder error propagates (fail closed)", async () => {
    const tools = fakeTools({
      // oxlint-disable-next-line require-yield
      async *sampleVideo() {
        throw new Error("ffmpeg failed");
      },
    });
    const { moderation } = await makeModeration({ tools });
    await expect(moderation.scanVideoFile("/x.mp4", 10, new Date())).rejects.toThrow("ffmpeg failed");
  });

  test("scanChunks groups by init segment and bounds each chunk", () => {
    const seg = (uri: string, map: string | null, d = 4): PlaylistSegment => ({
      uri,
      map,
      durationSeconds: d,
      startedAt: null,
    });
    const segs = [
      ...Array.from({ length: 20 }, (_, i) => seg(`a${i}`, "init_a.mp4")),
      seg("b0", "init_b.mp4"),
      seg("c0", null, 90),
    ];
    const chunks = scanChunks(segs, 60);
    expect(chunks.map((c) => c.map((s) => s.uri).join(","))).toEqual([
      Array.from({ length: 15 }, (_, i) => `a${i}`).join(","),
      ["a15", "a16", "a17", "a18", "a19"].join(","),
      "b0",
      "c0",
    ]);
    expect(chunks.flat()).toHaveLength(segs.length);
    expect(scanChunks([])).toEqual([]);
  });

  test("live capture reads one frame over TCP RTSP as PNG", () => {
    const a = liveFrameArgs("rtsp://u:p@h:8554/live/x");
    expect(a).toEqual(expect.arrayContaining(["-rtsp_transport", "tcp", "-frames:v", "1", "-c:v", "png", "pipe:1"]));
  });
});

describe("durable T0 replay", () => {
  test("recovery logs only a fixed error category when object storage fails", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "commonair-recovery-log-"));
    const broadcastDir = join(workDir, "broadcasts", target.broadcastId);
    await mkdir(broadcastDir, { recursive: true });
    let queryCount = 0;
    type Query = {
      from: () => Query;
      where: () => Query;
      limit: () => Promise<unknown[]>;
    };
    const db = {
      select: () => {
        const rows = queryCount++ === 0 ? [] : [{ id: "vod", status: "recording" }];
        let query: Query;
        query = { from: () => query, where: () => query, limit: async () => rows };
        return query;
      },
    } as unknown as Database;
    const { logger, lines } = captureLogger();
    await recoverWorkDir({
      db,
      storage: {
        get: async () => {
          throw new Error("private://bucket/path/object-secret");
        },
      } as unknown as MediaContext["storage"],
      bucket: "media",
      workDir,
      logger,
    });
    const output = lines.join("\n");
    expect(output).toContain('"error":"Error"');
    expect(output).not.toContain("private://");
    expect(output).not.toContain("object-secret");
    await rm(workDir, { recursive: true, force: true });
  });

  test("restart keeps pending local segments private and kicks a still-live source before T0 acceptance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commonair-t0-replay-"));
    const outbox = new T0Outbox(dir);
    const workDir = await mkdtemp(join(tmpdir(), "commonair-t0-recovery-"));
    const queue = new FakeQueue();
    let publisherLive = true;
    let uploads = 0;
    const addT0 = queue.addT0.bind(queue);
    queue.addT0 = async (job) => {
      expect(publisherLive).toBe(false);
      return addT0(job);
    };
    const { moderation } = await makeModeration({
      queue,
      t0Outbox: outbox,
      resolveBroadcastId: async () => target.broadcastId,
      stopBroadcast: async () => {
        // The service's replay stop callback kicks MediaMTX even when no session was restored.
        publisherLive = false;
        queue.events.push("publisher-kicked");
        queue.events.push("quiesced");
      },
    });
    const hit = {
      match: {
        category: "csam" as const,
        provider: "pdq:local" as const,
        listVersion: "local:1:x",
        distance: 3,
        quality: 90,
      },
      frame: fakeFrame("a", 90),
      pdq: { hash: MATCH, quality: 90 },
      capturedAt: new Date(),
    };
    const job = {
      channelId: target.channelId,
      userId: null,
      listCategory: "csam" as const,
      provider: "pdq:local" as const,
      listVersion: "local:1:x",
      distance: 3,
      quality: 90,
      capturedAt: hit.capturedAt.toISOString(),
      evidence: await moderation.sealHit(hit),
    };
    await outbox.persist({ ...job, subjectType: "broadcast", subjectId: target.broadcastId });
    await outbox.persist({ ...job, subjectType: "vod", subjectId: "0192a1b2-0000-7000-8000-000000000009" });
    await outbox.persist({ ...job, subjectType: "clip", subjectId: "0192a1b2-0000-7000-8000-000000000010" });
    const localDir = join(workDir, "broadcasts", target.broadcastId);
    await mkdir(localDir, { recursive: true });
    const segmentPath = join(localDir, "segment-1.m4s");
    await writeFile(segmentPath, "synthetic pending recorder segment");
    const protectedBroadcastIds = await moderation.prepareT0Replay();
    await recoverWorkDir({
      db: stubDb(),
      storage: {
        put: async () => {
          uploads++;
        },
      } as unknown as MediaContext["storage"],
      bucket: "media",
      workDir,
      logger: captureLogger().logger,
      protectedBroadcastIds,
    });
    expect(uploads).toBe(0);
    expect(await Bun.file(segmentPath).exists()).toBe(true);
    await moderation.replayT0Outbox();
    expect(moderation.isLiveTainted(target.channelId, target.path)).toBe(true);
    await moderation.settle();
    expect(queue.events.indexOf("quiesced")).toBeGreaterThanOrEqual(0);
    expect(queue.t0s).toHaveLength(3);
    expect(queue.events.indexOf("t0")).toBeGreaterThan(queue.events.indexOf("quiesced"));
    expect(queue.events.indexOf("publisher-kicked")).toBeLessThan(queue.events.indexOf("t0"));
    expect(await outbox.pending()).toHaveLength(3);
    await rm(dir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  test("does not treat an unrelated T0 origin as acknowledgment, and retires only after hash-list commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commonair-t0-ack-"));
    const outbox = new T0Outbox(dir);
    const job = {
      subjectType: "broadcast" as const,
      subjectId: target.broadcastId,
      channelId: target.channelId,
      userId: null,
      listCategory: "csam" as const,
      provider: "pdq:local" as const,
      listVersion: "local:1:x",
      distance: 3,
      quality: 90,
      capturedAt: new Date().toISOString(),
      evidence: [
        {
          kind: "frame" as const,
          contentType: "image/png" as const,
          sealedBase64: "AA==",
          sha256: "0".repeat(64),
          sizeBytes: 1,
          keyId: "0".repeat(32),
          pdq: null,
          pdqQuality: null,
          capturedAt: new Date().toISOString(),
        },
      ],
    };
    await outbox.persist(job);
    const { moderation } = await makeModeration({
      t0Outbox: outbox,
      t0ActionCommitted: async () => false,
    });
    await moderation.prepareT0Replay();
    await moderation.replayT0Outbox();
    await moderation.settle();
    expect(await outbox.pending()).toHaveLength(1);
    expect(moderation.protectedBroadcastIds().has(target.broadcastId)).toBe(true);

    const committed = await makeModeration({
      t0Outbox: outbox,
      t0ActionCommitted: async () => true,
      stopBroadcast: async () => {},
    });
    await committed.moderation.prepareT0Replay();
    expect(await outbox.pending()).toHaveLength(1);
    await committed.moderation.finishT0Recovery();
    expect(await outbox.pending()).toEqual([]);
    expect(committed.moderation.protectedBroadcastIds().has(target.broadcastId)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("committed VOD/clip T0 recovery discards local segments without public upload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commonair-t0-committed-vod-"));
    const workDir = await mkdtemp(join(tmpdir(), "commonair-t0-committed-recovery-"));
    const outbox = new T0Outbox(dir);
    const { moderation } = await makeModeration({
      t0Outbox: outbox,
      resolveBroadcastId: async () => target.broadcastId,
      t0ActionCommitted: async () => true,
    });
    await outbox.persist({
      subjectType: "vod",
      subjectId: "0192a1b2-0000-7000-8000-000000000011",
      channelId: target.channelId,
      userId: null,
      listCategory: "csam",
      provider: "pdq:local",
      listVersion: "local:1:x",
      distance: 3,
      quality: 90,
      capturedAt: new Date().toISOString(),
      evidence: [
        {
          kind: "frame",
          contentType: "image/png",
          sealedBase64: "AA==",
          sha256: "0".repeat(64),
          sizeBytes: 1,
          keyId: "0".repeat(32),
          pdq: null,
          pdqQuality: null,
          capturedAt: new Date().toISOString(),
        },
      ],
    });
    const vodJob = (await outbox.pending())[0]?.job;
    if (!vodJob) throw new Error("expected durable VOD T0 record");
    await outbox.persist({
      ...vodJob,
      subjectType: "clip",
      subjectId: "0192a1b2-0000-7000-8000-000000000012",
    });
    const segmentDir = join(workDir, "broadcasts", target.broadcastId);
    await mkdir(segmentDir, { recursive: true });
    const segmentPath = join(segmentDir, "segment-1.m4s");
    await writeFile(segmentPath, "synthetic local segment");
    const protectedIds = await moderation.prepareT0Replay();
    expect(protectedIds.has(target.broadcastId)).toBe(true);
    expect(moderation.committedRecoveryBroadcastIds().has(target.broadcastId)).toBe(true);
    let uploads = 0;
    await recoverWorkDir({
      db: stubDb(),
      storage: { put: async () => uploads++ } as unknown as MediaContext["storage"],
      bucket: "media",
      workDir,
      logger: captureLogger().logger,
      protectedBroadcastIds: protectedIds,
      discardBroadcastIds: moderation.committedRecoveryBroadcastIds(),
    });
    expect(uploads).toBe(0);
    expect(await Bun.file(segmentPath).exists()).toBe(false);
    await moderation.finishT0Recovery();
    expect(moderation.protectedBroadcastIds().has(target.broadcastId)).toBe(false);
    await rm(dir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  test("periodic pruning retains acknowledgment until sweep discards committed broadcast bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commonair-t0-prune-"));
    const workDir = await mkdtemp(join(tmpdir(), "commonair-t0-prune-work-"));
    const outbox = new T0Outbox(dir);
    const { moderation } = await makeModeration({ t0Outbox: outbox, t0ActionCommitted: async () => true });
    await outbox.persist({
      subjectType: "broadcast",
      subjectId: target.broadcastId,
      channelId: target.channelId,
      userId: null,
      listCategory: "csam",
      provider: "pdq:local",
      listVersion: "local:1:x",
      distance: 3,
      quality: 90,
      capturedAt: new Date().toISOString(),
      evidence: [
        {
          kind: "frame",
          contentType: "image/png",
          sealedBase64: "AA==",
          sha256: "0".repeat(64),
          sizeBytes: 1,
          keyId: "0".repeat(32),
          pdq: null,
          pdqQuality: null,
          capturedAt: new Date().toISOString(),
        },
      ],
    });
    const segmentDir = join(workDir, "broadcasts", target.broadcastId);
    await mkdir(segmentDir, { recursive: true });
    const segmentPath = join(segmentDir, "segment-1.m4s");
    await writeFile(segmentPath, "synthetic local segment");
    await moderation.pruneCommittedT0Outbox();
    expect(await outbox.pending()).toHaveLength(1);
    expect(moderation.protectedBroadcastIds().has(target.broadcastId)).toBe(true);
    await sweepWorkDir({
      db: stubDb(),
      storage: {} as MediaContext["storage"],
      bucket: "media",
      workDir,
      logger: captureLogger().logger,
      owned: moderation.protectedBroadcastIds(),
      activeScratch: new ActiveScratch(),
      broadcastDirMaxAgeMs: 0,
      discardBroadcastIds: moderation.committedRecoveryBroadcastIds(),
    });
    await moderation.finishT0Recovery();
    expect(await Bun.file(segmentPath).exists()).toBe(false);
    expect(await outbox.pending()).toEqual([]);
    await rm(dir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  test("a crash before recovery completion leaves committed acknowledgment durable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commonair-t0-recovery-failure-"));
    const outbox = new T0Outbox(dir);
    const { moderation } = await makeModeration({
      t0Outbox: outbox,
      t0ActionCommitted: async () => true,
    });
    const job = {
      subjectType: "broadcast" as const,
      subjectId: target.broadcastId,
      channelId: target.channelId,
      userId: null,
      listCategory: "csam" as const,
      provider: "pdq:local" as const,
      listVersion: "local:1:x",
      distance: 3,
      quality: 90,
      capturedAt: new Date().toISOString(),
      evidence: [
        {
          kind: "frame" as const,
          contentType: "image/png" as const,
          sealedBase64: "AA==",
          sha256: "0".repeat(64),
          sizeBytes: 1,
          keyId: "0".repeat(32),
          pdq: null,
          pdqQuality: null,
          capturedAt: new Date().toISOString(),
        },
      ],
    };
    await outbox.persist(job);
    const protectedIds = await moderation.prepareT0Replay();
    expect(protectedIds.has(target.broadcastId)).toBe(true);
    expect(moderation.committedRecoveryBroadcastIds().has(target.broadcastId)).toBe(true);
    // Simulate process death after preparation and before discard/finish.
    expect(await outbox.pending()).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  test("replay that observes a newly committed VOD action waits for local discard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commonair-t0-replay-ack-race-"));
    const workDir = await mkdtemp(join(tmpdir(), "commonair-t0-replay-ack-work-"));
    const outbox = new T0Outbox(dir);
    let actionChecks = 0;
    const { moderation } = await makeModeration({
      t0Outbox: outbox,
      resolveBroadcastId: async () => target.broadcastId,
      t0ActionCommitted: async () => ++actionChecks >= 3,
    });
    await outbox.persist({
      subjectType: "vod",
      subjectId: "0192a1b2-0000-7000-8000-000000000013",
      channelId: target.channelId,
      userId: null,
      listCategory: "csam",
      provider: "pdq:local",
      listVersion: "local:1:x",
      distance: 3,
      quality: 90,
      capturedAt: new Date().toISOString(),
      evidence: [
        {
          kind: "frame",
          contentType: "image/png",
          sealedBase64: "AA==",
          sha256: "0".repeat(64),
          sizeBytes: 1,
          keyId: "0".repeat(32),
          pdq: null,
          pdqQuality: null,
          capturedAt: new Date().toISOString(),
        },
      ],
    });
    await moderation.prepareT0Replay();
    await moderation.replayT0Outbox();
    expect(await outbox.pending()).toHaveLength(1);
    expect(moderation.committedRecoveryBroadcastIds().has(target.broadcastId)).toBe(true);
    const segmentDir = join(workDir, "broadcasts", target.broadcastId);
    await mkdir(segmentDir, { recursive: true });
    const segmentPath = join(segmentDir, "segment-1.m4s");
    await writeFile(segmentPath, "synthetic local segment");
    let uploads = 0;
    await recoverWorkDir({
      db: stubDb(),
      storage: { put: async () => uploads++ } as unknown as MediaContext["storage"],
      bucket: "media",
      workDir,
      logger: captureLogger().logger,
      protectedBroadcastIds: moderation.protectedBroadcastIds(),
      discardBroadcastIds: moderation.committedRecoveryBroadcastIds(),
    });
    await moderation.finishT0Recovery();
    expect(uploads).toBe(0);
    expect(await Bun.file(segmentPath).exists()).toBe(false);
    expect(await outbox.pending()).toEqual([]);
    await rm(dir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  test("strict session stop propagates a worker failure and can retry quiescence", async () => {
    const { logger } = captureLogger();
    let failures = 1;
    const idle = { stop: async () => {} };
    const session = Object.create(BroadcastSession.prototype) as unknown as {
      stopped: Promise<void> | null;
      log: typeof logger;
      ctx: { enqueueVodFinalize: () => Promise<void> };
      frames: { stop: () => Promise<void> };
      thumbnails: typeof idle;
      transcode: typeof idle;
      simulcast: typeof idle;
      sampler: typeof idle;
      recorder: { stop: (final: boolean, strict: boolean) => Promise<void> };
      stop: (final: boolean, finalizeVod: boolean, strict: boolean) => Promise<void>;
    };
    session.stopped = null;
    session.log = logger;
    session.ctx = { enqueueVodFinalize: async () => {} };
    session.frames = {
      stop: async () => {
        if (failures-- > 0) throw new Error("synthetic worker stop failure");
      },
    };
    session.thumbnails = idle;
    session.transcode = idle;
    session.simulcast = idle;
    session.sampler = idle;
    session.recorder = { stop: async () => {} };
    await expect(session.stop(true, false, true)).rejects.toThrow("synthetic worker stop failure");
    await session.stop(true, false, true);
  });

  test("strict recorder quiescence rejects failed segment uploads and keeps local bytes", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "commonair-recorder-t0-"));
    const broadcastId = target.broadcastId;
    const dir = join(workDir, "broadcasts", broadcastId);
    await mkdir(dir, { recursive: true });
    const localPath = join(dir, "segment-1.m4s");
    await writeFile(localPath, "synthetic segment bytes");
    const { logger } = captureLogger();
    const ctx = {
      workDir,
      logger,
      bucket: "media",
      storage: {
        put: async () => {
          throw new Error("synthetic storage failure");
        },
      },
    } as unknown as MediaContext;
    const recorder = new SegmentRecorder(
      ctx,
      {
        broadcastId,
        channelId: target.channelId,
        slug: "synthetic",
        path: target.path,
        title: "synthetic",
        startedAt: new Date(),
        vodEnabled: true,
      },
      "0192a1b2-0000-7000-8000-000000000008",
    );
    const state = recorder as unknown as {
      local: Array<{
        uri: string;
        durationSeconds: number;
        startedAt: Date;
        map: null;
        localPath: string;
        uploaded: boolean;
      }>;
    };
    state.local.push({
      uri: "segment-1.m4s",
      durationSeconds: 10,
      startedAt: new Date(),
      map: null,
      localPath,
      uploaded: false,
    });
    await expect(recorder.stop(true, true)).rejects.toThrow("synthetic storage failure");
    expect(await Bun.file(localPath).exists()).toBe(true);
    await rm(workDir, { recursive: true, force: true });
  });
});

describe("startup and list reloads", () => {
  const list = (category: "csam" | "ncii", provider: "pdq:operator-list" | "pdq:local", version: string): HashList => ({
    category,
    provider,
    version,
    size: 0,
    nearest: () => null,
  });
  const tools = (over: Partial<ListTools> = {}) => {
    const matcher = fakeMatcher({});
    const watched: { onError?: (e: Error, c: "csam" | "ncii") => void } = {};
    const t: ListTools = {
      loadFile: async (_p, c) => list(c, "pdq:operator-list", "empty:0"),
      staticList: (c, p, _h, v) => list(c, p, v),
      createMatcher: (ls) => {
        matcher.replaced.push(...ls);
        return matcher;
      },
      watchFiles: (_f, _m, onError) => {
        watched.onError = onError;
        return () => {};
      },
      ...over,
    };
    return { t, matcher, watched };
  };

  test("loads operator and local lists and logs versions and sizes only", async () => {
    const { t, matcher } = tools();
    const { logger, lines } = captureLogger();
    const loaded = await loadLists({
      db: stubDb(),
      sources: { csamPath: "/l/csam.pdq", nciiPath: "" },
      logger,
      tools: t,
    });
    expect(loaded.matcher).toBe(matcher);
    expect(matcher.replaced.map((l) => `${l.provider}:${l.category}`)).toEqual([
      "pdq:operator-list:csam",
      "pdq:operator-list:ncii",
      "pdq:local:csam",
      "pdq:local:ncii",
    ]);
    const line = lines.find((l) => l.includes("moderation hash lists loaded")) ?? "";
    expect(line).toContain("local:0:none");
    expect(line).not.toContain("/l/csam.pdq");
  });

  test("a bad operator list refuses to start with the line number only", async () => {
    const { t } = tools({
      loadFile: async () => {
        throw new HashListParseError(7);
      },
    });
    const { logger, lines } = captureLogger();
    await expect(
      loadLists({ db: stubDb(), sources: { csamPath: "/l/csam.pdq", nciiPath: "" }, logger, tools: t }),
    ).rejects.toThrow("failed to load");
    const fatal = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.level === "fatal");
    expect(fatal).toMatchObject({ line: 7 });
    expect(JSON.stringify(fatal)).not.toContain("/l/csam.pdq");
  });

  test("an unreadable local list at startup refuses to start", async () => {
    const { t } = tools();
    await expect(
      loadLists({
        db: stubDb({ fail: true }),
        sources: { csamPath: "", nciiPath: "" },
        logger: captureLogger().logger,
        tools: t,
      }),
    ).rejects.toThrow("database unavailable");
  });

  test("a failed reload keeps the last good list", async () => {
    const { t, matcher, watched } = tools();
    const { logger, lines } = captureLogger();
    const loaded = await loadLists({
      db: stubDb(),
      sources: { csamPath: "/l/csam.pdq", nciiPath: "" },
      logger,
      tools: t,
    });
    const before = matcher.replaced.length;
    watched.onError?.(new HashListParseError(3), "csam");
    expect(lines.some((l) => l.includes('"line":3') && l.includes("keeping the last good list"))).toBe(true);
    // Unchanged local version: nothing replaced.
    await loaded.refreshLocal();
    expect(matcher.replaced.length).toBe(before);
  });

  test("a failed local reload keeps the last good list", async () => {
    const { t, matcher } = tools();
    const db = stubDb();
    const loaded = await loadLists({
      db,
      sources: { csamPath: "", nciiPath: "" },
      logger: captureLogger().logger,
      tools: t,
    });
    const before = matcher.replaced.length;
    const failing = stubDb({ fail: true });
    (db as unknown as { select: unknown }).select = (f: Parameters<typeof failing.select>[0]) => failing.select(f);
    await loaded.refreshLocal();
    expect(matcher.replaced.length).toBe(before);
  });

  test("a bad evidence public key refuses to start", async () => {
    const { logger, lines } = captureLogger();
    await expect(
      setupModeration({
        env: {
          MODERATION_SAMPLE_SECONDS: 10,
          MODERATION_HASHLIST_CSAM: "",
          MODERATION_HASHLIST_NCII: "",
          EVIDENCE_PUBLIC_KEY: Buffer.from(new Uint8Array(31)).toString("base64"),
          VALKEY_URL: "redis://127.0.0.1:9",
        },
        db: stubDb(),
        valkey: { set: async () => "OK" },
        logger,
        ffmpeg: "ffmpeg",
        t0OutboxDir: join(tmpdir(), `commonair-setup-outbox-${crypto.randomUUID()}`),
        kickPublisher: async () => {},
        stopBroadcast: async () => {},
        resolveBroadcastId: async () => null,
        t0ActionCommitted: async () => false,
        overrides: { queue: new FakeQueue() },
      }),
    ).rejects.toThrow("evidence public key");
    expect(lines.some((l) => JSON.parse(l).level === "fatal")).toBe(true);
  });

  test("startup with a good key and lists yields a working pipeline", async () => {
    const { publicB64 } = await testKeys();
    const { t } = tools();
    const rt = await setupModeration({
      env: {
        MODERATION_SAMPLE_SECONDS: 10,
        MODERATION_HASHLIST_CSAM: "",
        MODERATION_HASHLIST_NCII: "",
        EVIDENCE_PUBLIC_KEY: publicB64,
        VALKEY_URL: "redis://127.0.0.1:9",
      },
      db: stubDb(),
      valkey: { set: async () => "OK" },
      logger: captureLogger().logger,
      ffmpeg: "ffmpeg",
      t0OutboxDir: join(tmpdir(), `commonair-setup-outbox-${crypto.randomUUID()}`),
      kickPublisher: async () => {},
      stopBroadcast: async () => {},
      resolveBroadcastId: async () => null,
      t0ActionCommitted: async () => false,
      overrides: { queue: new FakeQueue(), listTools: t, tools: fakeTools() },
    });
    expect(await rt.moderation.scanLiveFrame(target, fakeFrame("1", 90), new Date())).toBe("clean");
    await rt.stop();
  });
});
