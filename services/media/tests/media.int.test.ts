// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * End to end against real MediaMTX (with infra/mediamtx/mediamtx.yml), a second MediaMTX as the
 * mock simulcast target, a throwaway Garage, Postgres and Valkey, and real ffmpeg. One RTMP test
 * pattern drives a whole broadcast: hooks → health → thumbnails → simulcast → transcode → VOD
 * segments → live clip → offline (simulcast stopped, VOD finalized) → clip from the VOD, and a
 * second broadcast exercises the hash-match enforcement path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS, LiveEvent, MediaMtxAuthRequest, MediaReadyHook } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import { createValkey } from "@commonair/service";
import { encryptSecret } from "@commonair/tokens";
import { mediaServiceEnv } from "../src/env.ts";
import { probeCapabilities } from "../src/ffmpeg/hwaccel.ts";
import { runCommand } from "../src/ffmpeg/run.ts";
import { MediaMtxClient } from "../src/mediamtx.ts";
import type { HashMatcher } from "../src/safety/hashmatch.ts";
import { createMediaService, type MediaService } from "../src/service.ts";
import { VOD_PLAYLIST, vodPrefix } from "../src/vod/recorder.ts";
import {
  podmanAvailable,
  publishTestPattern,
  startGarage,
  startMediaMtx,
  startMockTarget,
  type Container,
  type Garage,
  type Publisher,
} from "./helpers/containers.ts";

if (!podmanAvailable()) throw new Error("media integration tests need podman (rootless is fine)");

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const BUCKET = "commonair-media";
const run = crypto.randomUUID().slice(0, 8);
const SLUG = `it_${run}`;
const INTERNAL_SECRET = `internal-${crypto.randomUUID()}`;
const AUTH_SECRET = `auth-${crypto.randomUUID()}`;
const SIMULCAST_KEY = `mockkey_${run}`;
const keyPrefix = `test:${crypto.randomUUID()}:`;
const bullPrefix = `test-bull-${run}`;
const busChannel = `test:bus:live:${run}`;

interface Hook {
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
const hooks: Hook[] = [];
/** Fake API: records MediaMTX auth and lifecycle hooks; allows everything except a suspended slug. */
const fakeApi = Bun.serve({
  port: 0,
  // Containers reach the host through host.containers.internal, which needs a non-loopback bind
  // on podman machine (macOS/Windows). The fake API accepts nothing but test hooks.
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => null)) as unknown;
    hooks.push({ path: url.pathname, headers: Object.fromEntries(req.headers), body });
    return new Response(null, { status: 204 });
  },
});

const toggle = { match: false };
/** Matches on demand, so one service instance can exercise both outcomes. */
const testMatcher: HashMatcher = {
  name: "test-toggle",
  records: true,
  async check() {
    return { matched: toggle.match, details: { test: true } };
  },
};

const logger = createLogger({ service: "media-int", level: (process.env.TEST_LOG_LEVEL as "info") ?? "fatal" });
let tdb: TestDatabase;
let mtx: Container;
let target: Container;
let garage: Garage;
let media: MediaService;
let publisher: Publisher | null = null;
let mtxApi: MediaMtxClient;
let targetApi: MediaMtxClient;
const valkey = createValkey(VALKEY_URL, { keyPrefix });
const sub = createValkey(VALKEY_URL);
const busEvents: LiveEvent[] = [];
const workDir = mkdtempSync(join(tmpdir(), "media-int-work-"));
let channelId: string;
let broadcastId: string;
let startedAt: Date;
let vodId: string;

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${lastErr instanceof Error ? `: ${lastErr.message}` : ""}`);
}

const publish = (event: LiveEvent) => valkey.publish(busChannel, JSON.stringify(event));

async function goLive(): Promise<{ id: string; startedAt: Date }> {
  publisher = publishTestPattern(`rtmp://127.0.0.1:${mtx.port("1935/tcp")}/live/${SLUG}?key=streamkey`);
  await waitFor("source ready in MediaMTX", async () => (await mtxApi.getPath(`live/${SLUG}`))?.ready);
  const id = uuidv7();
  const at = new Date();
  await tdb.db.insert(schema.broadcasts).values({
    id,
    channelId,
    ingestProtocol: "rtmp",
    path: `live/${SLUG}`,
    title: "Integration test",
    startedAt: at,
  });
  await publish({
    type: "online",
    channelId,
    broadcastId: id,
    slug: SLUG,
    path: `live/${SLUG}`,
    protocol: "rtmp",
    at: at.toISOString(),
  });
  await waitFor("session started", async () => media.coordinator.session(id));
  return { id, startedAt: at };
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  const apiBase = `http://host.containers.internal:${fakeApi.port}`;
  mtx = startMediaMtx({ apiBase, internalSecret: INTERNAL_SECRET });
  target = startMockTarget();
  garage = await startGarage(BUCKET);
  mtxApi = new MediaMtxClient(`http://127.0.0.1:${mtx.port("9997/tcp")}`, INTERNAL_SECRET);
  targetApi = new MediaMtxClient(`http://127.0.0.1:${target.port("9997/tcp")}`, "unused");
  await waitFor("MediaMTX API", async () => (await mtxApi.check(), true), 30_000);
  await waitFor("mock target API", async () => (await targetApi.check(), true), 30_000);

  const [user] = await tdb.db
    .insert(schema.users)
    .values({ name: SLUG, email: `${SLUG}@test.invalid`, username: SLUG })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("no user");
  const [channel] = await tdb.db
    .insert(schema.channels)
    .values({ ownerId: user.id, slug: SLUG, displayName: SLUG, vodEnabled: true, vodRetentionDays: 14 })
    .returning({ id: schema.channels.id });
  if (!channel) throw new Error("no channel");
  channelId = channel.id;
  await tdb.db.insert(schema.simulcastTargets).values({
    channelId,
    platform: "custom",
    name: "Mock target",
    rtmpUrl: `rtmp://127.0.0.1:${target.port("1936/tcp")}/live`,
    streamKeyCiphertext: await encryptSecret(AUTH_SECRET, "simulcast", SIMULCAST_KEY),
  });

  const env = mediaServiceEnv.parse({
    DATABASE_URL: tdb.url,
    VALKEY_URL,
    S3_ENDPOINT: garage.endpoint,
    S3_ACCESS_KEY_ID: garage.accessKeyId,
    S3_SECRET_ACCESS_KEY: garage.secretAccessKey,
    S3_BUCKET_MEDIA: BUCKET,
    MEDIAMTX_API_URL: `http://127.0.0.1:${mtx.port("9997/tcp")}`,
    MEDIAMTX_RTSP_URL: `rtsp://127.0.0.1:${mtx.port("8554/tcp")}`,
    INTERNAL_API_SECRET: INTERNAL_SECRET,
    AUTH_SECRET,
    TRANSCODE_VIEWER_THRESHOLD: "2",
    TRANSCODE_HWACCEL: "none",
  });
  await sub.subscribe(busChannel);
  sub.on("message", (_c: string, m: string) => busEvents.push(LiveEvent.parse(JSON.parse(m))));
  media = await createMediaService({
    env,
    logger,
    keyPrefix,
    bullPrefix,
    busChannel,
    workDir,
    hashMatcher: testMatcher,
    capabilities: await probeCapabilities("none"),
    timings: {
      healthSampleMs: 1_000,
      probeIntervalMs: 3_000,
      transcodePollMs: 500,
      transcodeStartAfterMs: 1_000,
      transcodeStopAfterMs: 2_000,
      thumbnailIntervalMs: 4_000,
      thumbnailFirstDelayMs: 3_000,
      recorderPollMs: 500,
      segmentSeconds: 2,
      reconcileMs: 5_000,
    },
  });
  await media.start();
  ({ id: broadcastId, startedAt } = await goLive());
}, 240_000);

afterAll(async () => {
  await publisher?.stop();
  await media?.stop();
  await sub.quit();
  // Only our own prefixes; never touch other tests' keys.
  const raw = createValkey(VALKEY_URL);
  for (const pattern of [`${keyPrefix}*`, `${bullPrefix}:*`]) {
    const keys = await raw.keys(pattern);
    if (keys.length > 0) await raw.del(...keys);
  }
  await raw.quit();
  await valkey.quit();
  await fakeApi.stop(true);
  if (process.env.TEST_MTX_LOGS) console.warn(mtx?.logs());
  mtx?.stop();
  target?.stop();
  garage?.stop();
  await tdb?.drop();
  rmSync(workDir, { recursive: true, force: true });
}, 60_000);

describe("media pipeline", () => {
  test("MediaMTX calls the API hooks with the contract payloads", async () => {
    const publishAuth = hooks.find(
      (h) => h.path === "/internal/media/auth" && (h.body as { action?: string } | null)?.action === "publish",
    );
    const parsed = MediaMtxAuthRequest.parse(publishAuth?.body);
    expect(parsed).toMatchObject({ action: "publish", protocol: "rtmp", path: `live/${SLUG}`, query: "key=streamkey" });

    const ready = await waitFor("ready hook", async () => hooks.find((h) => h.path === "/internal/media/ready"));
    expect(ready.headers["x-internal-secret"]).toBe(INTERNAL_SECRET);
    expect(ready.headers["content-type"]).toBe("application/json");
    expect(MediaReadyHook.parse(ready.body)).toMatchObject({ path: `live/${SLUG}`, sourceType: "rtmpConn" });

    // Our own API calls authenticate as the internal user.
    const apiAuth = hooks.find((h) => (h.body as { action?: string } | null)?.action === "api");
    expect(apiAuth?.body).toMatchObject({ user: "internal", password: INTERNAL_SECRET });
  });

  test("health: ffprobe-based sample with resolution, codecs and 2 s keyframes; live seconds accrue", async () => {
    const sample = await waitFor("probed health sample", async () => {
      const [s] = await tdb.db
        .select()
        .from(schema.broadcastHealthSamples)
        .where(and(eq(schema.broadcastHealthSamples.broadcastId, broadcastId)))
        .orderBy(desc(schema.broadcastHealthSamples.at))
        .limit(1);
      return s?.width ? s : null;
    });
    expect(sample).toMatchObject({ width: 1280, height: 720, videoCodec: "h264", audioCodec: "aac" });
    expect(sample.keyframeIntervalMs).toBeGreaterThanOrEqual(1500);
    expect(sample.keyframeIntervalMs).toBeLessThanOrEqual(2500);
    expect(sample.bitrateKbps).toBeGreaterThan(500);
    expect(sample.fps).toBeGreaterThan(20);
    expect(sample.warnings).not.toContain("keyframe_interval");
    expect(sample.warnings).not.toContain("audio_missing");

    const hours = await waitFor("stream hours", async () => {
      const rows = await tdb.db
        .select()
        .from(schema.streamHours)
        .where(eq(schema.streamHours.broadcastId, broadcastId));
      return rows.reduce((s, r) => s + r.liveSeconds, 0) > 0 ? rows : null;
    });
    expect(hours.every((r) => r.eligible === false && r.verifiedOtherViewers === 0)).toBe(true);
  }, 60_000);

  test("thumbnails are hash-checked, stored and referenced from the broadcast", async () => {
    const key = await waitFor("thumbnail key", async () => {
      const [b] = await tdb.db
        .select({ k: schema.broadcasts.thumbnailKey })
        .from(schema.broadcasts)
        .where(eq(schema.broadcasts.id, broadcastId));
      return b?.k;
    });
    expect(key.startsWith(`thumbnails/${broadcastId}/`)).toBe(true);
    const obj = await media.ctx.storage.head(BUCKET, key);
    expect(obj?.size).toBeGreaterThan(1000);
    const ext = key.slice(key.lastIndexOf("."));
    expect(await media.ctx.storage.head(BUCKET, `thumbnails/${broadcastId}/latest${ext}`)).not.toBeNull();
    const checks = await tdb.db
      .select()
      .from(schema.hashMatchResults)
      .where(eq(schema.hashMatchResults.subjectId, broadcastId));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.matched === false && c.provider === "test-toggle")).toBe(true);
  }, 60_000);

  test("simulcast reaches the mock target and reports live", async () => {
    const status = await waitFor("simulcast live", async () => {
      const all = await valkey.hgetall(KEYS.simulcastStatus(broadcastId));
      const v = Object.values(all)[0];
      const parsed = v ? (JSON.parse(v) as { status: string }) : null;
      return parsed?.status === "live" ? parsed : null;
    });
    expect(status.status).toBe("live");
    const [session] = await tdb.db
      .select()
      .from(schema.simulcastSessions)
      .where(eq(schema.simulcastSessions.broadcastId, broadcastId));
    expect(session?.status).toBe("live");
    const arrived = await waitFor("restream at mock target", async () =>
      (await targetApi.listPaths()).find((p) => p.name === `live/${SIMULCAST_KEY}` && p.ready),
    );
    expect(arrived.tracks).toContain("H264");
    // The key never leaks into status or errors.
    expect(JSON.stringify(await valkey.hgetall(KEYS.simulcastStatus(broadcastId)))).not.toContain(SIMULCAST_KEY);
  }, 60_000);

  test("transcode ladder starts above the viewer threshold and stops below it", async () => {
    const now = Date.now();
    await valkey.zadd(KEYS.viewers(channelId), now, "s1", now, "s2", now, "s3", now - 120_000, "stale");
    const keepFresh = setInterval(() => {
      const t = Date.now();
      void valkey.zadd(KEYS.viewers(channelId), t, "s1", t, "s2", t, "s3");
    }, 1000);
    try {
      const renditions = await waitFor("renditions key", async () => valkey.get(KEYS.renditions(channelId)), 60_000);
      expect(JSON.parse(renditions)).toEqual(["source", "720p", "480p", "audio"]);
      const p720 = await waitFor("720p rendition path", async () => {
        const p = await mtxApi.getPath(`live/${SLUG}/720p`);
        return p?.ready ? p : null;
      });
      expect(p720.tracks2?.[0]?.codecProps?.height).toBe(720);
      const [b] = await tdb.db
        .select({ t: schema.broadcasts.transcodeActive })
        .from(schema.broadcasts)
        .where(eq(schema.broadcasts.id, broadcastId));
      expect(b?.t).toBe(true);
      expect(busEvents.some((e) => e.type === "renditions" && e.renditions.includes("720p"))).toBe(true);
    } finally {
      clearInterval(keepFresh);
    }

    await valkey.del(KEYS.viewers(channelId));
    await waitFor("renditions withdrawn", async () => (await valkey.get(KEYS.renditions(channelId))) === null);
    await waitFor("720p path gone", async () => !(await mtxApi.getPath(`live/${SLUG}/720p`))?.ready);
    const [b] = await tdb.db
      .select({ t: schema.broadcasts.transcodeActive })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, broadcastId));
    expect(b?.t).toBe(false);
    const last = busEvents.filter((e) => e.type === "renditions").pop();
    expect(last?.type === "renditions" ? last.renditions : null).toEqual(["source"]);
  }, 90_000);

  test("VOD recording uploads segments and the playlist while live", async () => {
    const [vod] = await tdb.db.select().from(schema.vods).where(eq(schema.vods.broadcastId, broadcastId));
    expect(vod?.status).toBe("recording");
    vodId = vod?.id ?? "";
    expect(vod?.storagePrefix).toBe(vodPrefix(vodId));
    const keys = await waitFor("uploaded segments", async () => {
      const ks: string[] = [];
      for await (const o of media.ctx.storage.list(BUCKET, vodPrefix(vodId))) ks.push(o.key);
      return ks.filter((k) => k.endsWith(".m4s")).length >= 3 ? ks : null;
    });
    expect(keys.some((k) => /init_r[0-9a-z]+\.mp4$/.test(k))).toBe(true);
    expect(keys).toContain(`${vodPrefix(vodId)}${VOD_PLAYLIST}`);
    const playlist = await (await media.ctx.storage.get(BUCKET, `${vodPrefix(vodId)}${VOD_PLAYLIST}`))?.text();
    expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(playlist).not.toContain("#EXT-X-ENDLIST");
  }, 60_000);

  test("a live clip is cut from the rolling buffer", async () => {
    // Six seconds into the broadcast, once the buffer holds the whole window.
    const offset = 6;
    const from = new Date(startedAt.getTime() + offset * 1000);
    await waitFor("buffer covers the clip window", async () => {
      const w = media.coordinator.liveWindow(broadcastId, from, 4);
      return w !== null && w.durationSeconds >= 4;
    });
    const id = await createClip(offset, 4);
    const clip = await waitForClip(id);
    expect(clip.status).toBe("ready");
    expect(clip.durationSeconds).toBeGreaterThan(3);
    const duration = await mp4Duration(clip.storageKey ?? "");
    expect(duration).toBeGreaterThan(3.5);
    expect(duration).toBeLessThan(4.6);
  }, 60_000);

  test("offline: simulcast stops and the VOD is finalized", async () => {
    await publisher?.stop();
    publisher = null;
    await tdb.db.update(schema.broadcasts).set({ endedAt: new Date() }).where(eq(schema.broadcasts.id, broadcastId));
    await publish({
      type: "offline",
      channelId,
      broadcastId,
      slug: SLUG,
      path: `live/${SLUG}`,
      at: new Date().toISOString(),
    });
    await waitFor("simulcast stopped", async () => {
      const v = Object.values(await valkey.hgetall(KEYS.simulcastStatus(broadcastId)))[0];
      return v && (JSON.parse(v) as { status: string }).status === "stopped";
    });
    const [session] = await tdb.db
      .select()
      .from(schema.simulcastSessions)
      .where(eq(schema.simulcastSessions.broadcastId, broadcastId));
    expect(session?.status).toBe("stopped");
    expect(session?.endedAt).not.toBeNull();

    const vod = await waitFor("VOD ready", async () => {
      const [v] = await tdb.db.select().from(schema.vods).where(eq(schema.vods.id, vodId));
      return v?.status === "ready" ? v : null;
    });
    expect(vod.durationSeconds).toBeGreaterThan(10);
    expect(vod.sizeBytes).toBeGreaterThan(100_000);
    const days = ((vod.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    const playlist = await (await media.ctx.storage.get(BUCKET, `${vodPrefix(vodId)}${VOD_PLAYLIST}`))?.text();
    expect(playlist?.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
    expect(media.coordinator.session(broadcastId)).toBeUndefined();
  }, 90_000);

  test("after the broadcast, clips are cut from the VOD in object storage", async () => {
    const id = await createClip(6, 5);
    const clip = await waitForClip(id);
    expect(clip.status).toBe("ready");
    expect(clip.vodId).toBe(vodId);
    const duration = await mp4Duration(clip.storageKey ?? "");
    expect(duration).toBeGreaterThan(4.5);
    expect(duration).toBeLessThan(5.6);
    expect(clip.thumbnailKey).toMatch(new RegExp(`^clips/${id}\\.(webp|jpg)$`));
  }, 60_000);

  test("a clip outside any recording fails without retries", async () => {
    const id = await createClip(100_000, 5);
    const clip = await waitForClip(id);
    expect(clip.status).toBe("failed");
  }, 30_000);

  test("hash match: the publisher is kicked, the channel suspended and audited, no image stored", async () => {
    const live = await goLive();
    toggle.match = true;
    try {
      await waitFor("channel suspended", async () => {
        const [c] = await tdb.db.select().from(schema.channels).where(eq(schema.channels.id, channelId));
        return c?.suspendedAt ? c : null;
      });
      const [c] = await tdb.db.select().from(schema.channels).where(eq(schema.channels.id, channelId));
      expect(c?.suspendedReason).toBe("csam_hash_match");
      const audits = await tdb.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, channelId));
      const audit = audits.find((a) => a.details.broadcastId === live.id);
      expect(audit).toMatchObject({ actorType: "system", action: "channel.suspend", channelId });
      const matched = await tdb.db
        .select()
        .from(schema.hashMatchResults)
        .where(and(eq(schema.hashMatchResults.subjectId, live.id), eq(schema.hashMatchResults.matched, true)));
      expect(matched).toHaveLength(1);
      expect(audit?.details).toMatchObject({ hashMatchResultId: matched[0]?.id, broadcastId: live.id });

      // The publisher was disconnected and local work stopped.
      await waitFor("publisher kicked", async () => !(await mtxApi.getPath(`live/${SLUG}`))?.ready, 20_000);
      await waitFor("session stopped", async () => media.coordinator.session(live.id) === undefined, 20_000);
      const [b] = await tdb.db
        .select({ k: schema.broadcasts.thumbnailKey })
        .from(schema.broadcasts)
        .where(eq(schema.broadcasts.id, live.id));
      expect(b?.k).toBeNull();
      const stored: string[] = [];
      for await (const o of media.ctx.storage.list(BUCKET, `thumbnails/${live.id}/`)) stored.push(o.key);
      expect(stored).toEqual([]);
    } finally {
      toggle.match = false;
    }
  }, 90_000);

  test("readiness checks pass against the real dependencies", async () => {
    for (const [name, check] of Object.entries(media.checks)) await expect(check(), name).resolves.toBeUndefined();
  });
});

async function createClip(startOffset: number, durationSeconds: number): Promise<string> {
  const id = uuidv7();
  await tdb.db.insert(schema.clips).values({
    id,
    channelId,
    broadcastId,
    title: "clip",
    startOffset,
    durationSeconds,
  });
  await media.jobs.enqueueClip(id);
  return id;
}

async function waitForClip(id: string) {
  return waitFor("clip finished", async () => {
    const [c] = await tdb.db.select().from(schema.clips).where(eq(schema.clips.id, id));
    return c && c.status !== "processing" ? c : null;
  });
}

async function mp4Duration(key: string): Promise<number> {
  const res = await media.ctx.storage.get(BUCKET, key);
  if (!res) throw new Error(`missing ${key}`);
  const file = join(workDir, `check-${crypto.randomUUID()}.mp4`);
  await Bun.write(file, res);
  const { stdout } = await runCommand(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { timeoutMs: 15_000 },
  );
  return Number.parseFloat(new TextDecoder().decode(stdout));
}
