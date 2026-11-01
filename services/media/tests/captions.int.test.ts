// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The captions worker against real Postgres and Valkey and a fake whisper.cpp server (`Bun.serve`),
 * with a synthetic audio source and in-memory object storage: track rows, the FIFO queue at the
 * cap and its hand-over when a stream ends, the VOD track written under the VOD's prefix before
 * `onEnd` resolves (so before vod-finalize is enqueued), cues dropped without a VOD, rehearsals and
 * channels with captions off, and a shutdown that keeps the track for a successor.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { CAPTIONS_KEYS, MASK_TOKEN, parseVtt } from "@commonair/captions";
import { vodCaptionsKey, vodPrefix } from "@commonair/contracts/storage";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import { createValkey } from "@commonair/service";
import type { ObjectStorage } from "@commonair/storage";
import { createCaptions, type CaptionsRuntime } from "../src/captions/index.ts";
import { NOOP_CAPTIONS_METRICS } from "../src/captions/metrics.ts";
import { wavFile, type AudioSource } from "../src/captions/source.ts";
import type { MediaContext } from "../src/context.ts";
import { MediaSessionHooks, type MediaSessionInfo } from "../src/hooks.ts";

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const BUCKET = "media";
const keyPrefix = `test:captions:${crypto.randomUUID()}:`;
const valkey = createValkey(VALKEY_URL, { keyPrefix });
const logger = createLogger({ service: "media-test", level: "fatal" });

let tdb: TestDatabase;
let runtime: CaptionsRuntime;
let hooks: MediaSessionHooks;
const objects = new Map<string, { body: string; contentType?: string }>();
const whisperCalls: string[] = [];

const storage = {
  put: async (bucket: string, key: string, body: BodyInit, opts?: { contentType?: string }) => {
    objects.set(`${bucket}/${key}`, { body: await new Response(body).text(), contentType: opts?.contentType });
  },
  get: async (bucket: string, key: string) => {
    const o = objects.get(`${bucket}/${key}`);
    return o ? new Response(o.body) : null;
  },
} as unknown as ObjectStorage;

// A whisper.cpp stand-in: each chunk says "hello darn world" over its first two seconds.
const whisper = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const form = await req.formData();
    const language = form.get("language");
    whisperCalls.push(typeof language === "string" ? language : "");
    if (!(form.get("file") instanceof Blob)) return new Response("no file", { status: 400 });
    return Response.json({
      text: "hello darn world",
      segments: [{ id: 0, start: 0.2, end: 2.0, text: " hello darn world" }],
    });
  },
});

/** Chunks every 30 ms of wall time, stamped on a fake broadcast clock that starts at the session start. */
const source: AudioSource = async function* (session, signal) {
  let i = 0;
  const base = session.startedAt.getTime();
  while (!signal.aborted) {
    await Bun.sleep(30);
    if (signal.aborted) return;
    yield {
      startMs: base + i * 3000,
      endMs: base + (i + 1) * 3000,
      w0Ms: base - 10_000,
      wav: wavFile(new Uint8Array(64)),
    };
    i++;
  }
};

let channelOn: string;
let channelOff: string;
let channelEs: string;

async function channel(slug: string, settings: Record<string, unknown>, language = "en"): Promise<string> {
  const [u] = await tdb.db
    .insert(schema.users)
    .values({ name: slug, email: `${slug}@test.invalid`, username: slug })
    .returning({ id: schema.users.id });
  const [c] = await tdb.db
    .insert(schema.channels)
    .values({ ownerId: u!.id, slug, displayName: slug, language, captionsSettings: settings as never })
    .returning({ id: schema.channels.id });
  return c!.id;
}

async function broadcast(
  channelId: string,
  opts: { vod?: boolean; kind?: "live" | "rehearsal" } = {},
): Promise<MediaSessionInfo> {
  const [b] = await tdb.db
    .insert(schema.broadcasts)
    .values({ channelId, ingestProtocol: "rtmp", path: `live/${uuidv7()}`, kind: opts.kind ?? "live" })
    .returning();
  let vodId: string | null = null;
  if (opts.vod) {
    vodId = uuidv7();
    await tdb.db.insert(schema.vods).values({
      id: vodId,
      channelId,
      broadcastId: b!.id,
      title: "v",
      storagePrefix: vodPrefix(vodId, "private"),
    });
    // The recorder's playlist: the VOD's time 0 is its first PDT.
    objects.set(`${BUCKET}/${vodPrefix(vodId, "private")}index.m3u8`, {
      body: `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:${new Date(b!.startedAt.getTime() + 1000).toISOString()}\n#EXTINF:2,\na.m4s\n`,
    });
  }
  return {
    broadcastId: b!.id,
    channelId,
    slug: "s",
    path: b!.path,
    kind: b!.kind,
    startedAt: b!.startedAt,
    vodId,
  };
}

const trackOf = async (broadcastId: string) =>
  (
    await tdb.db
      .select()
      .from(schema.broadcastCaptionTracks)
      .where(eq(schema.broadcastCaptionTracks.broadcastId, broadcastId))
  )[0];

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const start = (s: MediaSessionInfo) => hooks.start(s, { signal: new AbortController().signal });

beforeAll(async () => {
  tdb = await createTestDatabase();
  channelOn = await channel("cap_on", { enabled: true, spokenLanguage: null, maskWords: ["darn"] });
  channelOff = await channel("cap_off", { enabled: false, spokenLanguage: null, maskWords: [] });
  channelEs = await channel("cap_es", { enabled: null, spokenLanguage: "es", maskWords: [] }, "en");
  const ctx = { db: tdb.db, valkey, storage, bucket: BUCKET, logger } as unknown as MediaContext;
  hooks = new MediaSessionHooks(logger);
  runtime = createCaptions({
    ctx,
    env: { CAPTIONS_MAX_STREAMS: 1, WHISPER_URL: `http://127.0.0.1:${whisper.port}` },
    source,
    metrics: NOOP_CAPTIONS_METRICS,
  });
  hooks.register(runtime.hook);
}, 60_000);

afterAll(async () => {
  await runtime?.manager?.stopAll();
  await whisper.stop(true);
  const raw = createValkey(VALKEY_URL);
  const keys = await raw.keys(`${keyPrefix}*`);
  if (keys.length > 0) await raw.del(...keys);
  await raw.quit();
  await valkey.quit();
  await tdb?.drop();
});

describe("captions worker", () => {
  test("queue at the cap; the first stream's VOD track lands under its prefix before onEnd resolves; the next starts", async () => {
    const a = await broadcast(channelOn, { vod: true });
    const b = await broadcast(channelOn);
    await start(a);
    await start(b);
    expect((await trackOf(a.broadcastId))?.status).toBe("active");
    expect((await trackOf(b.broadcastId))?.status).toBe("queued");
    expect(runtime.manager?.status).toEqual({ active: [a.broadcastId], queued: [b.broadcastId] });

    // Live cues are masked in Valkey; the live record is what the origin serves.
    const live = await until("a live track", async () => valkey.get(CAPTIONS_KEYS.live(a.broadcastId)));
    expect(JSON.parse(live)).toMatchObject({ language: "en", anchorMs: a.startedAt.getTime() });
    await until("three chunks", async () => (await valkey.zcard(CAPTIONS_KEYS.cues(a.broadcastId, "en"))) >= 3);
    const raw = await valkey.zrange(CAPTIONS_KEYS.cues(a.broadcastId, "en"), 0, -1);
    expect(raw.join("")).not.toContain("darn");
    expect(raw.join("")).toContain(MASK_TOKEN);

    await hooks.end(a, { final: true });
    // Written before onEnd resolved: vod-finalize (enqueued after it) moves it with the VOD.
    const key = vodCaptionsKey(vodPrefix(a.vodId!, "private"), "en");
    const obj = objects.get(`${BUCKET}/${key}`);
    expect(obj?.contentType).toMatch(/^text\/vtt/);
    const vtt = parseVtt(obj!.body)!;
    expect(vtt.originMs).toBe(a.startedAt.getTime() + 1000);
    expect(vtt.cues.length).toBeGreaterThanOrEqual(3);
    // Chunk 0 is [start, start+3 s]; its cue starts 200 ms in, the VOD's 0 is 1 s after start.
    expect(vtt.cues[0]).toEqual({ startMs: 0, endMs: 1000, text: `hello ${MASK_TOKEN} world` });
    const ready = await trackOf(a.broadcastId);
    expect(ready).toMatchObject({ status: "ready", vodId: a.vodId, storageKey: key, cueCount: vtt.cues.length });
    expect(await valkey.exists(CAPTIONS_KEYS.live(a.broadcastId), CAPTIONS_KEYS.cues(a.broadcastId, "en"))).toBe(0);

    // The queued stream took the freed slot.
    await until("b active", async () => (await trackOf(b.broadcastId))?.status === "active");
    expect(runtime.manager?.status).toEqual({ active: [b.broadcastId], queued: [] });

    // Ending again (a retried stop) changes nothing.
    await hooks.end(a, { final: true });
    expect((await trackOf(a.broadcastId))?.status).toBe("ready");

    // No VOD: the transcript is dropped (ADR 0011 decision 6).
    await until("b cues", async () => (await valkey.zcard(CAPTIONS_KEYS.cues(b.broadcastId, "en"))) >= 1);
    await hooks.end(b, { final: true });
    expect(await trackOf(b.broadcastId)).toMatchObject({ status: "deleted", cueCount: 0, storageKey: null });
    expect(await valkey.exists(CAPTIONS_KEYS.live(b.broadcastId), CAPTIONS_KEYS.cues(b.broadcastId, "en"))).toBe(0);
    expect(runtime.slots.inUse).toBe(0);
  }, 60_000);

  test("a queued stream that ends before its turn leaves the queue and keeps nothing", async () => {
    const a = await broadcast(channelOn);
    const b = await broadcast(channelOn, { vod: true });
    const c = await broadcast(channelOn);
    for (const s of [a, b, c]) await start(s);
    expect(runtime.manager?.status.queued).toEqual([b.broadcastId, c.broadcastId]);
    await hooks.end(b, { final: true }); // the stream crashed while waiting
    expect((await trackOf(b.broadcastId))?.status).toBe("deleted");
    await hooks.end(a, { final: true });
    // c, not b, gets the slot (start order among those still waiting).
    await until("c active", async () => (await trackOf(c.broadcastId))?.status === "active");
    await hooks.end(c, { final: true });
  }, 60_000);

  test("a session that ends while its worker is still starting leaves no stream running", async () => {
    // Hold the worker's queued -> active update until the session has ended (onEnd sees no stream).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reachedActivate!: () => void;
    const atActivate = new Promise<void>((r) => (reachedActivate = r));
    const db = new Proxy(tdb.db, {
      get(target, prop, receiver) {
        if (prop !== "update") return Reflect.get(target, prop, receiver) as unknown;
        return (table: typeof schema.broadcastCaptionTracks) => {
          const builder = target.update(table);
          return {
            set: (values: { status?: string }) => {
              const set = builder.set(values as never);
              if (values.status !== "active") return set;
              return {
                where: (cond: Parameters<typeof set.where>[0]) => {
                  const q = set.where(cond);
                  reachedActivate();
                  // Awaiting the builder runs it; only after the gate opens.
                  return gate.then(async () => await q);
                },
              };
            },
          };
        };
      },
    });
    const ctx = { db, valkey, storage, bucket: BUCKET, logger } as unknown as MediaContext;
    const own = createCaptions({
      ctx,
      env: { CAPTIONS_MAX_STREAMS: 1, WHISPER_URL: `http://127.0.0.1:${whisper.port}` },
      source,
      metrics: NOOP_CAPTIONS_METRICS,
    });
    const manager = own.manager!;
    try {
      const s = await broadcast(channelOn);
      const ctl = new AbortController();
      const starting = manager.onStart(s, { signal: ctl.signal });
      await atActivate;
      ctl.abort();
      await manager.onEnd(s, { final: true });
      release();
      await starting;
      expect(manager.status).toEqual({ active: [], queued: [] });
      expect(own.slots.inUse).toBe(0);
      expect((await trackOf(s.broadcastId))?.status).toBe("deleted");
    } finally {
      release();
      await manager.stopAll();
    }
  }, 60_000);

  test("rehearsals and channels with captions off get no track", async () => {
    const r = await broadcast(channelOn, { kind: "rehearsal" });
    const off = await broadcast(channelOff);
    // Follows the instance default, seeded off.
    const def = await broadcast(channelEs);
    for (const s of [r, off, def]) await start(s);
    for (const s of [r, off, def]) expect(await trackOf(s.broadcastId)).toBeUndefined();
    expect(runtime.manager?.status).toEqual({ active: [], queued: [] });
    for (const s of [r, off, def]) await hooks.end(s, { final: true });
  });

  test("the spoken language setting goes to whisper and names the track", async () => {
    await tdb.db
      .update(schema.channels)
      .set({ captionsSettings: { enabled: true, spokenLanguage: "es", maskWords: [] } })
      .where(eq(schema.channels.id, channelEs));
    whisperCalls.length = 0;
    const s = await broadcast(channelEs);
    await start(s);
    expect(await trackOf(s.broadcastId)).toMatchObject({ language: "es", status: "active" });
    await until("a whisper call", async () => whisperCalls.length > 0);
    expect(whisperCalls[0]).toBe("es");
    await hooks.end(s, { final: true });
  });

  test("a shutdown keeps the row and the cues for the successor host, which resumes the track", async () => {
    const s = await broadcast(channelOn, { vod: true });
    await start(s);
    await until("cues", async () => (await valkey.zcard(CAPTIONS_KEYS.cues(s.broadcastId, "en"))) >= 2);
    await hooks.end(s, { final: false });
    expect((await trackOf(s.broadcastId))?.status).toBe("active");
    const kept = await valkey.zcard(CAPTIONS_KEYS.cues(s.broadcastId, "en"));
    expect(kept).toBeGreaterThanOrEqual(2);
    expect(runtime.slots.inUse).toBe(0);
    await start(s);
    await until("more cues", async () => (await valkey.zcard(CAPTIONS_KEYS.cues(s.broadcastId, "en"))) > kept);
    await hooks.end(s, { final: true });
    expect((await trackOf(s.broadcastId))?.status).toBe("ready");
  }, 60_000);
});
