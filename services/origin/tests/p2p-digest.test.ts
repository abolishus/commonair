// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `/p2p-digest/` (ADR 0005 amendment 1, decision 7) against a fake content store. */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { sourceAacPath } from "@commonair/contracts/internal";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import type { Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { generateSigningKey, signPlaybackToken, type SigningKey } from "@commonair/tokens";
import type { SourceAacState } from "../src/channels.ts";
import type { ContentStore, MediaObject, ObjectRef } from "../src/content.ts";
import type { OriginMetrics } from "../src/metrics.ts";
import { createOrigin } from "../src/origin.ts";
import { createP2PDigestHandler, P2P_DIGEST_ROUTE, type P2PDigestDeps } from "../src/p2p-digest.ts";
import { UpstreamError } from "../src/upstream.ts";

const CID = "0190f1c2-0000-7000-8000-00000000c0de";
const SID = "0190f1c2-0000-7000-8000-0000000005e5";
const RID = "0190f1c2-0000-7000-8000-0000000000e1";
const SEG = "54dd20fd99ec_video1_seg33.mp4";
const BYTES = new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) % 256));

let key: SigningKey;
let pkcs8: string;
beforeAll(async () => {
  const g = await generateSigningKey();
  key = g.key;
  pkcs8 = g.pkcs8B64;
});

const nowS = () => Math.floor(Date.now() / 1000);
const token = (over: Partial<PlaybackClaims> = {}) =>
  signPlaybackToken(key, {
    v: 1,
    sid: SID,
    cid: CID,
    path: "live/test",
    src: "origin",
    iat: nowS(),
    exp: nowS() + 120,
    ...over,
  } as PlaybackClaims);

interface Fake {
  store: ContentStore;
  calls: ObjectRef[];
  objects: Map<string, MediaObject | Error>;
}
function fakeStore(): Fake {
  const calls: ObjectRef[] = [];
  const objects = new Map<string, MediaObject | Error>();
  const store = {
    get: (ref: ObjectRef) => {
      calls.push(ref);
      const o = objects.get(`${ref.upstreamPath}/${ref.file}`);
      if (o instanceof Error) return Promise.reject(o);
      return Promise.resolve(o ?? { status: 404, body: new Uint8Array(0), contentType: "text/plain", size: 0 });
    },
  } as unknown as ContentStore;
  return { store, calls, objects };
}
const obj = (body: Uint8Array): MediaObject => ({
  status: 200,
  body: new Uint8Array(body),
  contentType: "video/mp4",
  size: body.byteLength,
});

interface Recorded {
  requests: [string, string, string, number][];
  egressed: [string, number][];
}
function recordingMetrics(): OriginMetrics & Recorded {
  const requests: Recorded["requests"] = [];
  const egressed: Recorded["egressed"] = [];
  return {
    requests,
    egressed,
    request: (route, kind, source, status) => void requests.push([route, kind, source, status]),
    cache: () => {},
    upstream: () => {},
    egress: (source, bytes) => void egressed.push([source, bytes]),
    accountingDropped: () => {},
  };
}

function setup(extra: Partial<P2PDigestDeps> = {}) {
  const fake = fakeStore();
  fake.objects.set(`live/test/${SEG}`, obj(BYTES));
  const metrics = recordingMetrics();
  const handler = createP2PDigestHandler({ publicKey: key.publicKey, store: fake.store, metrics, ...extra });
  const call = (path: string, init?: RequestInit) => {
    const req = new Request(`http://o${path}`, init);
    return handler(req, path.split("?")[0] ?? path);
  };
  return { ...fake, metrics, handler, call };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("p2p digest", () => {
  test("the route", () => {
    expect(P2P_DIGEST_ROUTE).toBe("/p2p-digest/");
  });

  test("the digest is the SHA-256 of the served bytes: 64 lowercase hex characters", async () => {
    const s = setup();
    const r = await s.call(`/p2p-digest/live/test/${SEG}?t=${await token()}`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toBe(sha256(BYTES));
    expect(body).toMatch(/^[0-9a-f]{64}$/);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("private, max-age=120");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(s.calls).toEqual([{ upstreamPath: "live/test", file: SEG, kind: "segment" }]);
    expect(s.metrics.requests).toEqual([["p2p_digest", "segment", "origin", 200]]);
    expect(s.metrics.egressed).toEqual([["p2p_digest", 64]]);
  });

  test("a rendition segment hashes the rendition's object", async () => {
    const s = setup();
    const other = new Uint8Array([1, 2, 3]);
    s.objects.set("live/test/720p/seg9.m4s", obj(other));
    const r = await s.call(`/p2p-digest/live/test/720p/seg9.m4s?t=${await token()}`);
    expect(await r.text()).toBe(sha256(other));
  });

  test("memoized: one store call and one hash per object, concurrent or later", async () => {
    const s = setup();
    let hashes = 0;
    const subtle = crypto.subtle;
    const orig = subtle.digest.bind(subtle);
    const spy = (alg: AlgorithmIdentifier, data: BufferSource) => {
      hashes++;
      return orig(alg, data);
    };
    Object.defineProperty(subtle, "digest", { value: spy, configurable: true });
    try {
      const tk = await token();
      const rs = await Promise.all(Array.from({ length: 5 }, () => s.call(`/p2p-digest/live/test/${SEG}?t=${tk}`)));
      const again = await s.call(`/p2p-digest/live/test/${SEG}?t=${await token({ sid: RID })}`);
      for (const r of [...rs, again]) expect(await r.text()).toBe(sha256(BYTES));
      expect(s.calls).toHaveLength(1);
      expect(hashes).toBe(1);
    } finally {
      Object.defineProperty(subtle, "digest", { value: orig, configurable: true });
    }
  });

  test("a failed lookup is not memoized", async () => {
    const s = setup();
    const tk = await token();
    s.objects.set("live/test/seg7.mp4", new UpstreamError("down", "network"));
    expect((await s.call(`/p2p-digest/live/test/seg7.mp4?t=${tk}`)).status).toBe(502);
    s.objects.set("live/test/seg7.mp4", obj(BYTES));
    const r = await s.call(`/p2p-digest/live/test/seg7.mp4?t=${tk}`);
    expect(r.status).toBe(200);
    expect(s.calls).toHaveLength(2);
  });

  test("memo entries expire with the store's media TTL", async () => {
    let t = 1_000_000;
    const s = setup({ now: () => t });
    // Token times follow the fake clock.
    const tk = await token({ iat: Math.floor(t / 1000), exp: Math.floor(t / 1000) + 600 });
    await s.call(`/p2p-digest/live/test/${SEG}?t=${tk}`);
    t += 60_000;
    await s.call(`/p2p-digest/live/test/${SEG}?t=${tk}`);
    expect(s.calls).toHaveLength(1);
    t += 61_000;
    await s.call(`/p2p-digest/live/test/${SEG}?t=${tk}`);
    expect(s.calls).toHaveLength(2);
  });

  test.each([
    ["the media playlist", "/p2p-digest/live/test/video1_stream.m3u8"],
    ["the multivariant playlist", "/p2p-digest/live/test/index.m3u8"],
    ["an LL-HLS part", "/p2p-digest/live/test/54dd20fd99ec_video1_part155.mp4"],
    ["an unknown rendition", "/p2p-digest/live/test/360p/seg1.mp4"],
    ["a nested path", "/p2p-digest/live/test/720p/x/seg1.mp4"],
    ["a dot segment", "/p2p-digest/live/../test/seg1.mp4"],
    ["percent-encoding", "/p2p-digest/live/test/seg%31.mp4"],
    ["a bad extension", "/p2p-digest/live/test/seg1.exe"],
    ["not live/", "/p2p-digest/vod/test/seg1.mp4"],
    ["a bad slug", "/p2p-digest/live/A/seg1.mp4"],
    ["the bare route", "/p2p-digest/"],
  ])("%s: 404 without a store call", async (_, path) => {
    const s = setup();
    const r = await s.call(`${path}?t=${await token()}`);
    expect(r.status).toBe(404);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(s.calls).toHaveLength(0);
    // Refused non-segments never borrow the segment label.
    expect(s.metrics.requests).toEqual([["p2p_digest", "other", "unauthenticated", 404]]);
  });

  test("tokens: missing, malformed, bad signature, expired, wrong path, a VOD token", async () => {
    const s = setup();
    const other = (await generateSigningKey()).key;
    const cases: [string, string][] = [
      ["", "forbidden: missing"],
      ["?t=abc", "forbidden: malformed"],
      [`?t=${"x".repeat(5000)}`, "forbidden: malformed"],
      [
        `?t=${await signPlaybackToken(other, { v: 1, sid: SID, cid: CID, path: "live/test", src: "origin", iat: nowS(), exp: nowS() + 120 })}`,
        "forbidden: bad_signature",
      ],
      [`?t=${await token({ iat: nowS() - 600, exp: nowS() - 300 })}`, "forbidden: expired"],
      [`?t=${await token({ path: "live/other" })}`, "forbidden: wrong_path"],
      [`?t=${await token({ path: `vod/${SID}` })}`, "forbidden: wrong_path"],
    ];
    for (const [q, error] of cases) {
      const r = await s.call(`/p2p-digest/live/test/${SEG}${q}`);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error });
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    expect(s.calls).toHaveLength(0);
    expect(
      s.metrics.requests.every(
        ([route, , src, status]) => route === "p2p_digest" && src === "unauthenticated" && status === 403,
      ),
    ).toBe(true);
  });

  test("relay and CDN tokens are accepted", async () => {
    const s = setup();
    for (const src of ["relay", "cdn"] as const) {
      const r = await s.call(
        `/p2p-digest/live/test/${SEG}?t=${await token({ src, ...(src === "relay" ? { rid: RID } : {}) })}`,
      );
      expect(r.status).toBe(200);
      expect(await r.text()).toBe(sha256(BYTES));
    }
    expect(s.metrics.requests.map((r) => r[2])).toEqual(["relay", "cdn"]);
  });

  test("HEAD has no body and no egress", async () => {
    const s = setup();
    const r = await s.call(`/p2p-digest/live/test/${SEG}?t=${await token()}`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(s.metrics.egressed).toEqual([]);
  });

  test("OPTIONS answers the CORS preflight; other methods 405", async () => {
    const s = setup();
    const pre = await s.call(`/p2p-digest/live/test/${SEG}`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    const post = await s.call(`/p2p-digest/live/test/${SEG}?t=${await token()}`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(s.calls).toHaveLength(0);
  });

  test("upstream: 404 is 404, a full queue 503, other failures 502", async () => {
    const s = setup();
    const tk = await token();
    expect((await s.call(`/p2p-digest/live/test/seg404.mp4?t=${tk}`)).status).toBe(404);
    s.objects.set("live/test/q.mp4", new UpstreamError("busy", "queue"));
    const q = await s.call(`/p2p-digest/live/test/q.mp4?t=${tk}`);
    expect(q.status).toBe(503);
    expect(q.headers.get("retry-after")).toBe("1");
    s.objects.set("live/test/t.mp4", new UpstreamError("slow", "timeout"));
    expect((await s.call(`/p2p-digest/live/test/t.mp4?t=${tk}`)).status).toBe(502);
    s.objects.set("live/test/e.mp4", { status: 500, body: new Uint8Array(0), contentType: "text/plain", size: 0 });
    expect((await s.call(`/p2p-digest/live/test/e.mp4?t=${tk}`)).status).toBe(502);
  });

  test("no SegmentFetch: the handler has no segment log at all, and the store is only read", async () => {
    // The deps carry no SegmentLog; the origin-level check is in p2p-digest.int.test.ts.
    const s = setup();
    await s.call(`/p2p-digest/live/test/${SEG}?t=${await token()}`);
    expect(Object.keys(s.store)).toEqual(["get"]);
  });

  describe("with the channel directory", () => {
    const channels = (aac: SourceAacState, id: string | null = CID) => ({
      lookup: (slug: string) => Promise.resolve(id ? { id, slug, broadcastId: RID } : null),
      sourceAac: () => Promise.resolve(aac),
    });

    test("the source while an AAC copy is live hashes the copy, as /hls/ serves it", async () => {
      const s = setup({ channels: channels("live") });
      const copy = new Uint8Array([9, 9, 9]);
      s.objects.set(`${sourceAacPath("test")}/${SEG}`, obj(copy));
      const r = await s.call(`/p2p-digest/live/test/${SEG}?t=${await token()}`);
      expect(await r.text()).toBe(sha256(copy));
      // Renditions never use the copy.
      s.objects.set("live/test/720p/seg9.m4s", obj(BYTES));
      expect(await (await s.call(`/p2p-digest/live/test/720p/seg9.m4s?t=${await token()}`)).text()).toBe(sha256(BYTES));
    });

    test("a handler built without the directory warns once; with it, never", () => {
      const warned: string[] = [];
      const logger: Logger = {
        trace() {},
        debug() {},
        info() {},
        warn: (msg: string) => void warned.push(msg),
        error() {},
        fatal() {},
        child: () => logger,
      };
      setup({ logger });
      expect(warned).toEqual(["p2p digest without a channel directory"]);
      setup({ logger, channels: channels("off") });
      expect(warned).toHaveLength(1);
    });

    test("pending copy 503, offline 404, another channel's token 403", async () => {
      const tk = await token();
      expect((await setup({ channels: channels("pending") }).call(`/p2p-digest/live/test/${SEG}?t=${tk}`)).status).toBe(
        503,
      );
      expect(
        (await setup({ channels: channels("off", null) }).call(`/p2p-digest/live/test/${SEG}?t=${tk}`)).status,
      ).toBe(404);
      const wrong = await setup({ channels: channels("off", RID) }).call(`/p2p-digest/live/test/${SEG}?t=${tk}`);
      expect(wrong.status).toBe(403);
      expect(await wrong.json()).toEqual({ error: "forbidden: wrong_channel" });
    });
  });
});

describe("the origin dispatch", () => {
  async function origin() {
    // No request below reaches the database, Valkey or MediaMTX.
    return createOrigin({
      db: {} as Executor,
      valkey: {} as ValkeyClient,
      playbackSigningKey: pkcs8,
      mediamtxHlsUrl: "http://127.0.0.1:9",
      internalSecret: "s".repeat(32),
      mediaPassword: "p".repeat(32),
      cacheMb: 1,
      cdn: { provider: "none" },
    });
  }

  test("/p2p-digest/ reaches the digest handler: a bad token is 403 with CORS, a playlist 404", async () => {
    const o = await origin();
    const r = await o.fetch(new Request(`http://o/p2p-digest/live/test/${SEG}?t=x`));
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await r.json()) as { error: string }).error).toBe("forbidden: malformed");
    const pl = await o.fetch(new Request(`http://o/p2p-digest/live/test/index.m3u8?t=${await token()}`));
    expect(pl.status).toBe(404);
  });

  test("/hls/ is unchanged: a request without a valid token is refused by the HLS handler", async () => {
    const o = await origin();
    const r = await o.fetch(new Request(`http://o/hls/live/test/${SEG}`));
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/^forbidden: /);
  });
});
