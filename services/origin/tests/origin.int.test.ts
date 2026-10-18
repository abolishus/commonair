// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The origin end to end against a real MediaMTX (rootless Podman, random host ports)
 * fed by an ffmpeg test pattern, with real Postgres and Valkey.
 *
 * Requires `podman` and `ffmpeg` on PATH.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { KEYS, MEDIA_INTERNAL_USER } from "@commonair/contracts/internal";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { generateSigningKey, randomSecret, sha256Hex, signPlaybackToken, type SigningKey } from "@commonair/tokens";
import { minuteOf } from "../src/accounting.ts";
import { cdnAuthValue } from "../src/auth.ts";
import { sessionAllowance } from "../src/issuance.ts";
import { createOrigin, type Origin } from "../src/origin.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const IMAGE = "docker.io/bluenviron/mediamtx:1.21.2";
const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const CDN_BASE = "https://cdn.test.invalid";

const container = `origin-test-${crypto.randomUUID().slice(0, 8)}`;
const secret = randomSecret("", 32);
const relayToken = randomSecret("relay_");
const prefix = `test:${crypto.randomUUID()}:`;
const stream = `stream:segments:${crypto.randomUUID()}`;
let cfgDir = "";
let t: TestDatabase;
let valkey: ValkeyClient;
let key: SigningKey;
let origin: Origin;
let server: ReturnType<typeof Bun.serve>;
let base = "";
const publishers: ReturnType<typeof Bun.spawn>[] = [];

const ids = {
  owner: uuidv7(),
  channel: uuidv7(),
  broadcast: uuidv7(),
  offlineOwner: uuidv7(),
  offlineChannel: uuidv7(),
  relayOwner: uuidv7(),
  relay: uuidv7(),
  viewerSession: uuidv7(),
};

function sh(args: string[]): string {
  const p = Bun.spawnSync(args, { stderr: "pipe", stdout: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

const hostPort = (containerPort: string) => Number(sh(["podman", "port", container, containerPort]).split(":").at(-1));

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

function publish(rtspPort: number, path: string, size: string): void {
  publishers.push(
    Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner -loglevel error -re -f lavfi -i".split(" "),
        `testsrc2=size=${size}:rate=30`,
        "-f lavfi -i sine -c:v libx264 -preset ultrafast -tune zerolatency -g 30 -c:a aac".split(" "),
        "-t 300 -f rtsp -rtsp_transport tcp".split(" "),
        `rtsp://${MEDIA_INTERNAL_USER}:${secret}@127.0.0.1:${rtspPort}/${path}`,
      ].flat(),
      { stdout: "ignore", stderr: "ignore" },
    ),
  );
}

const claims = (over: Partial<PlaybackClaims> = {}): PlaybackClaims => {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    sid: ids.viewerSession,
    cid: ids.channel,
    path: "live/test",
    src: "origin",
    iat: now,
    exp: now + 120,
    ...over,
  } as PlaybackClaims;
};
const token = (over: Partial<PlaybackClaims> = {}) => signPlaybackToken(key, claims(over));
const get = (path: string, init?: RequestInit) => fetch(new URL(path, base), init);
const text = async (path: string, init?: RequestInit) => {
  const r = await get(path, init);
  return { status: r.status, headers: r.headers, body: await r.text() };
};

/** Every URI in a playlist. */
function uris(playlist: string): string[] {
  return playlist.split("\n").flatMap((l) => {
    if (l === "") return [];
    if (!l.startsWith("#")) return [l];
    return [...l.matchAll(/(?:^|[:,])URI="([^"]*)"/g)].map((m) => m[1] ?? "");
  });
}

async function seed(db: TestDatabase["db"]) {
  const user = (id: string, username: string) => ({ id, name: username, email: `${username}@test.invalid`, username });
  await db
    .insert(schema.users)
    .values([user(ids.owner, "test"), user(ids.offlineOwner, "sleepy"), user(ids.relayOwner, "relayer")]);
  await db.insert(schema.channels).values([
    { id: ids.channel, ownerId: ids.owner, slug: "test", displayName: "Test" },
    { id: ids.offlineChannel, ownerId: ids.offlineOwner, slug: "sleepy", displayName: "Sleepy" },
  ]);
  await db
    .insert(schema.broadcasts)
    .values({ id: ids.broadcast, channelId: ids.channel, ingestProtocol: "rtsp", path: "live/test" });
  await db.update(schema.channels).set({ liveBroadcastId: ids.broadcast }).where(eq(schema.channels.id, ids.channel));
  await db.insert(schema.relayNodes).values({
    id: ids.relay,
    ownerId: ids.relayOwner,
    name: "r1",
    publicUrl: "https://relay.test.invalid",
    declaredCapacityMbps: 100,
    publicKey: "A".repeat(43),
    tokenHash: await sha256Hex(relayToken),
    status: "active",
  });
  const relaySession = () => ({
    id: uuidv7(),
    channelId: ids.channel,
    broadcastId: ids.broadcast,
    deviceHash: "d",
    ipHash: "i",
    assignedSource: "relay" as const,
    relayId: ids.relay,
    lastHeartbeatAt: new Date(),
  });
  await db.insert(schema.playbackSessions).values([
    relaySession(),
    relaySession(),
    // Ended long ago: never counted.
    { ...relaySession(), startedAt: new Date(0), lastHeartbeatAt: new Date(1000), endedAt: new Date(2000) },
  ]);
}

beforeAll(async () => {
  for (const bin of ["podman", "ffmpeg"])
    if (!Bun.which(bin)) throw new Error(`${bin} is required for origin integration tests`);
  cfgDir = mkdtempSync(join(tmpdir(), "origin-test-"));
  writeFileSync(
    join(cfgDir, "mediamtx.yml"),
    [
      "logLevel: warn",
      "authMethod: internal",
      "authInternalUsers:",
      `  - user: ${MEDIA_INTERNAL_USER}`,
      `    pass: ${secret}`,
      "    permissions: [{ action: publish }, { action: read }]",
      "api: false",
      "rtmp: false",
      "webrtc: false",
      "srt: false",
      "hls: true",
      "hlsAddress: :8888",
      "hlsVariant: lowLatency",
      "hlsAlwaysRemux: true",
      "rtsp: true",
      "rtspTransports: [tcp]",
      "rtspAddress: :8554",
      "paths:",
      "  all_others:",
      "",
    ].join("\n"),
  );
  sh([
    "podman",
    "run",
    "--rm",
    "-d",
    "--name",
    container,
    "-p",
    "127.0.0.1::8888",
    "-p",
    "127.0.0.1::8554",
    "-v",
    `${join(cfgDir, "mediamtx.yml")}:/mediamtx.yml:ro`,
    IMAGE,
  ]);
  const hlsUrl = `http://127.0.0.1:${hostPort("8888/tcp")}`;
  const rtspPort = hostPort("8554/tcp");

  const [db, generated] = await Promise.all([createTestDatabase(), generateSigningKey()]);
  t = db;
  key = generated.key;
  valkey = createValkey(VALKEY_URL, { keyPrefix: prefix });
  await seed(t.db);

  await waitFor("mediamtx http", async () => (await fetch(hlsUrl)).status);
  publish(rtspPort, "live/test", "640x360");
  publish(rtspPort, "live/test/720p", "320x180");

  origin = await createOrigin({
    db: t.db,
    valkey,
    playbackSigningKey: generated.pkcs8B64,
    mediamtxHlsUrl: hlsUrl,
    internalSecret: secret,
    mediaPassword: secret,
    cacheMb: 64,
    cdn: { provider: "origin-pull", baseUrl: CDN_BASE },
    segmentStream: stream,
    segmentFlushMs: 50,
    // Offline answers are cached 2 s; keep tests fast by not caching negatives while MediaMTX warms up.
    ttls: { negativeMs: 0 },
  });
  origin.start();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => origin.fetch(req) });
  base = `http://127.0.0.1:${server.port}`;

  // Wait until both paths have produced a few segments.
  const tk = await token();
  for (const p of ["/hls/live/test/video1_stream.m3u8", "/hls/live/test/720p/video1_stream.m3u8"]) {
    await waitFor(`${p} playable`, async () => {
      // Media playlists need an upstream session, created by the path's multivariant.
      await get(`${p.replace("video1_stream", "index")}?t=${tk}`);
      const r = await text(`${p}?t=${tk}`);
      return r.status === 200 && (r.body.match(/#EXTINF/g)?.length ?? 0) >= 3 ? r : undefined;
    });
  }
});

afterAll(async () => {
  for (const p of publishers) p.kill();
  await server?.stop(true);
  await origin?.stop();
  Bun.spawnSync(["podman", "rm", "-f", container], { stdout: "ignore", stderr: "ignore" });
  await valkey?.del(stream);
  await valkey?.quit();
  await t?.drop();
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
});

describe("viewer playback (/hls)", () => {
  test("multivariant: synthesized ladder with rewritten, tokenized URIs", async () => {
    const tk = await token();
    await valkey.set(KEYS.renditions(ids.channel), JSON.stringify(["source", "720p"]), "EX", 60);
    // The renditions key is cached for 2 s, so the ladder appears within a couple of seconds.
    const r = await waitFor(
      "synthesized ladder",
      async () => {
        const res = await text(`/hls/live/test/index.m3u8?t=${tk}`);
        return res.body.includes("720p/") ? res : undefined;
      },
      5_000,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.body).not.toContain("session=");
    const all = uris(r.body);
    for (const u of all) expect(new URL(u, base).searchParams.getAll("t")).toEqual([tk]);
    const variants = r.body.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF"));
    // source + 720p + derived audio-only
    expect(variants).toHaveLength(3);
    expect(variants[0]).toContain("RESOLUTION=640x360");
    expect(variants[1]).toContain("RESOLUTION=320x180");
    expect(variants[2]).toMatch(/CODECS="mp4a/);
    expect(all.some((u) => u.startsWith("720p/video1_stream.m3u8?"))).toBe(true);
    await valkey.del(KEYS.renditions(ids.channel));
  });

  test("media playlist, init, segment and part all stream through", async () => {
    const tk = await token();
    const pl = await text(`/hls/live/test/video1_stream.m3u8?t=${tk}`);
    expect(pl.status).toBe(200);
    const all = uris(pl.body);
    const init = all.find((u) => u.includes("_init.mp4"));
    const seg = all.filter((u) => u.includes("_seg")).at(-1);
    const part = all.filter((u) => u.includes("_part")).at(0);
    for (const u of [init, seg, part]) {
      expect(u).toBeDefined();
      const res = await get(`/hls/live/test/${u}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp4");
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
    }
    // Rendition segments use the same channel token.
    const r720 = await text(`/hls/live/test/720p/video1_stream.m3u8?t=${tk}`);
    const seg720 = uris(r720.body)
      .filter((u) => u.includes("_seg"))
      .at(-1);
    expect((await get(`/hls/live/test/720p/${seg720}`)).status).toBe(200);
  });

  test("HEAD and CORS preflight", async () => {
    const tk = await token();
    const head = await get(`/hls/live/test/video1_stream.m3u8?t=${tk}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
    const pre = await get("/hls/live/test/index.m3u8", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
    expect((await get(`/hls/live/test/index.m3u8?t=${tk}`, { method: "POST" })).status).toBe(405);
  });

  test("invalid, expired, wrong-path, wrong-channel and relay-source tokens are refused with 403", async () => {
    const good = await token();
    const now = Math.floor(Date.now() / 1000);
    const { key: other } = await generateSigningKey();
    const cases: [string, string][] = [
      ["missing", ""],
      ["tampered", `${good.slice(0, -4)}AAAA`],
      ["foreign key", await signPlaybackToken(other, claims())],
      ["expired", await token({ iat: now - 600, exp: now - 300 })],
      ["wrong path", await token({ path: "live/sleepy" })],
      ["wrong channel", await token({ cid: ids.offlineChannel })],
      ["relay source", await token({ src: "relay", rid: ids.relay })],
    ];
    for (const [name, tk] of cases) {
      const r = await get(`/hls/live/test/video1_stream.m3u8${tk ? `?t=${tk}` : ""}`);
      expect(r.status, name).toBe(403);
    }
    const seg = await get(`/hls/live/test/x_video1_seg1.mp4?t=${await token({ path: "live/sleepy" })}`);
    expect(seg.status).toBe(403);
  });

  test("offline and unknown channels answer 404 quickly; malformed paths 404 without upstream", async () => {
    const before = origin.upstream.requests;
    const off = await get(`/hls/live/sleepy/index.m3u8?t=${await token({ path: "live/sleepy" })}`);
    expect(off.status).toBe(404);
    const unknown = await get(`/hls/live/nobody_here/index.m3u8?t=${await token({ path: "live/nobody_here" })}`);
    expect(unknown.status).toBe(404);
    for (const p of ["/hls/live/test/../x/index.m3u8", "/hls/live/test/index.php", "/hls/live/test/a/b/c.mp4"])
      expect((await get(p)).status).toBe(404);
    expect(origin.upstream.requests).toBe(before);
  });

  test("100 concurrent blocking playlist requests cause at most 2 upstream requests", async () => {
    const tk = await token();
    const pl = await text(`/hls/live/test/video1_stream.m3u8?t=${tk}`);
    const msn = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(pl.body)?.[1]);
    const segs = pl.body.match(/#EXTINF/g)?.length ?? 0;
    const next = msn + segs + 1;
    const before = origin.upstream.requests;
    const results = await Promise.all(
      Array.from({ length: 100 }, () => text(`/hls/live/test/video1_stream.m3u8?_HLS_msn=${next}&_HLS_part=0&t=${tk}`)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.includes(`_seg${next - 1}.mp4`) || r.body.includes("_part"))).toBe(true);
    expect(origin.upstream.requests - before).toBeLessThanOrEqual(2);
    expect(results[0]?.headers.get("cache-control")).toBe("private, max-age=6");
  });

  test("SegmentFetch entries land in the Valkey stream", async () => {
    const tk = await token();
    await get(`/hls/live/test/video1_stream.m3u8?t=${tk}`);
    await origin.segments.flush();
    const entries = await waitFor("segment fetches", async () => {
      const e = await valkey.xrange(stream, "-", "+");
      return e.length > 0 ? e : undefined;
    });
    const fields = Object.fromEntries(
      (entries.at(-1)?.[1] ?? []).flatMap((_, i, a) => (i % 2 === 0 ? [[a[i], a[i + 1]]] : [])),
    );
    expect(fields).toMatchObject({ sid: ids.viewerSession, cid: ids.channel, src: "origin", kind: "playlist" });
    expect(Number(fields.bytes)).toBeGreaterThan(0);
    expect(Number(fields.at)).toBeGreaterThan(Date.now() - 60_000);
    const kinds = new Set(entries.map(([, f]) => f[f.indexOf("kind") + 1]));
    expect(kinds).toEqual(new Set(["playlist", "segment", "part"]));
  });
});

describe("relay pull (/relay-pull)", () => {
  test("bearer relay token gets raw playlists with relative URIs and no tokens", async () => {
    const auth = { headers: { authorization: `Bearer ${relayToken}` } };
    const pl = await text("/relay-pull/live/test/video1_stream.m3u8", auth);
    expect(pl.status).toBe(200);
    expect(pl.headers.get("cache-control")).toBe("no-cache");
    expect(pl.headers.get("access-control-allow-origin")).toBeNull();
    const all = uris(pl.body);
    expect(all.length).toBeGreaterThan(3);
    for (const u of all) expect(u).toMatch(/^[A-Za-z0-9_]+\.(mp4|m3u8)$/);
    const seg = await get(`/relay-pull/live/test/${all.filter((u) => u.includes("_seg")).at(-1)}`, auth);
    expect(seg.status).toBe(200);
    expect(seg.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
  });

  test("unknown or missing relay tokens are refused", async () => {
    expect((await get("/relay-pull/live/test/video1_stream.m3u8")).status).toBe(401);
    const bad = { headers: { authorization: `Bearer ${randomSecret("relay_")}` } };
    expect((await get("/relay-pull/live/test/video1_stream.m3u8", bad)).status).toBe(401);
    // A viewer token is not a relay credential.
    expect((await get(`/relay-pull/live/test/video1_stream.m3u8?t=${await token()}`)).status).toBe(401);
  });
});

describe("CDN origin-pull (/cdn)", () => {
  test("needs the shared HMAC header; returns shareable playlists", async () => {
    expect((await get("/cdn/live/test/video1_stream.m3u8")).status).toBe(403);
    const ok = await text("/cdn/live/test/video1_stream.m3u8", {
      headers: { "x-cdn-auth": await cdnAuthValue(secret) },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toContain("t=");
    expect(ok.body).not.toContain("session=");
  });

  test("cdn-assigned viewers get playlists pointing at CDN_BASE_URL", async () => {
    const tk = await token({ src: "cdn" });
    const r = await text(`/hls/live/test/index.m3u8?t=${tk}`);
    expect(r.status).toBe(200);
    for (const u of uris(r.body)) expect(u.startsWith(`${CDN_BASE}/live/test/`)).toBe(true);
  });
});

describe("accounting", () => {
  test("SegmentFetch bytes and src match what was served; the origin never writes egress_samples", async () => {
    // egress_samples belongs to the worker (aggregated from STREAMS.segments); start the stream clean.
    await origin.segments.flush();
    await valkey.del(stream);
    const served: { kind: string; bytes: number; src: string }[] = [];
    for (const src of ["origin", "cdn"] as const) {
      const pl = await get(`/hls/live/test/video1_stream.m3u8?t=${await token({ src })}`);
      served.push({ kind: "playlist", bytes: (await pl.arrayBuffer()).byteLength, src });
    }
    const pl = await text(`/hls/live/test/video1_stream.m3u8?t=${await token()}`);
    served.push({ kind: "playlist", bytes: new TextEncoder().encode(pl.body).byteLength, src: "origin" });
    const seg = uris(pl.body)
      .filter((u) => u.includes("_seg"))
      .at(-1);
    const segRes = await get(`/hls/live/test/${seg}`);
    served.push({ kind: "segment", bytes: (await segRes.arrayBuffer()).byteLength, src: "origin" });
    // Relay and CDN pulls carry no viewer session, so they produce no SegmentFetch.
    await get("/relay-pull/live/test/video1_stream.m3u8", { headers: { authorization: `Bearer ${relayToken}` } });
    await get("/cdn/live/test/video1_stream.m3u8", { headers: { "x-cdn-auth": await cdnAuthValue(secret) } });
    await origin.segments.flush();
    const entries = await valkey.xrange(stream, "-", "+");
    const recorded = entries.map(([, f]) => {
      const m = Object.fromEntries(f.flatMap((_, i, a) => (i % 2 === 0 ? [[a[i], a[i + 1]]] : [])));
      return { kind: String(m.kind), bytes: Number(m.bytes), src: String(m.src), sid: m.sid, cid: m.cid };
    });
    expect(recorded.map(({ kind, bytes, src }) => ({ kind, bytes, src }))).toEqual(served);
    for (const r of recorded) expect(r).toMatchObject({ sid: ids.viewerSession, cid: ids.channel });
    expect(await t.db.select().from(schema.egressSamples)).toEqual([]);
  });

  test("relay issuance: sessions × production for the minute, upserted idempotently", async () => {
    const auth = { headers: { authorization: `Bearer ${relayToken}` } };
    // Make sure this minute has production: pull playlists and the newest objects as a relay would.
    const bucket = await waitFor("production this minute", async () => {
      await t.db.update(schema.playbackSessions).set({ lastHeartbeatAt: new Date() });
      const pl = await text("/relay-pull/live/test/video1_stream.m3u8", auth);
      for (const u of uris(pl.body).slice(-3)) await get(`/relay-pull/live/test/${u}`, auth);
      const m = minuteOf(Date.now());
      await origin.production.flush();
      const prod = (await origin.production.read(m)).get("live/test");
      return prod && sessionAllowance(prod).segments > 0 && sessionAllowance(prod).bytes > 0 ? m : undefined;
    });
    await origin.production.flush();
    const rows = await origin.runIssuance(bucket);
    const allowance = sessionAllowance((await origin.production.read(bucket)).get("live/test"));
    expect(rows).toEqual([
      {
        relayId: ids.relay,
        bucketStart: new Date(bucket),
        sessions: 2,
        segmentTokens: 2 * allowance.segments,
        bytesIssued: 2 * allowance.bytes,
      },
    ]);
    await origin.runIssuance(bucket);
    const stored = await t.db.select().from(schema.relayIssuance);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ relayId: ids.relay, sessions: 2 });
    expect(stored[0]?.bytesIssued).toBeGreaterThanOrEqual(2 * allowance.bytes);
  });
});
