// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { S3Error, type GetOptions } from "@commonair/storage";
import { createMediaHandler, publicMediaKey } from "../src/media.ts";

describe("publicMediaKey", () => {
  test("public prefixes map to their key", () => {
    expect(publicMediaKey("/media/clips/0190-ab.mp4")).toBe("clips/0190-ab.mp4");
    expect(publicMediaKey("/media/vods/v1/index.m3u8")).toBe("vods/v1/index.m3u8");
    expect(publicMediaKey("/media/thumbnails/b1/0001.webp")).toBe("thumbnails/b1/0001.webp");
    expect(publicMediaKey("/media/channels/c/avatar/a%20b.png")).toBe("channels/c/avatar/a b.png");
  });

  test("private prefixes, climbing and malformed paths are refused", () => {
    for (const bad of [
      "/media/moderation/ncii-hidden/clips/x.mp4", // NCII auto-hide
      "/media/moderation/case/flag.jpg", // review frames
      "/media/incoming/channels/c/avatar/x.png", // unscanned uploads
      "/media/evidence/a/b",
      "/media/clips", // a prefix alone is not an object
      "/media/clips/",
      "/media/",
      "/media/clips//x.mp4",
      "/media/clips/../moderation/ncii-hidden/clips/x.mp4",
      "/media/clips/%2e%2e/moderation/ncii-hidden/clips/x.mp4",
      "/media/clips/..%2fmoderation%2fx.mp4",
      "/media/clips%2f..%2fmoderation/x.mp4",
      "/media/clips/a%5cb.mp4",
      "/media/clips/a%00.mp4",
      "/media/clips/%E0%A4%A.mp4", // bad percent-encoding
      "/media/./clips/x.mp4",
      "/media/Clips/x.mp4",
      "/mediaclips/x.mp4",
      "/hls/live/a/index.m3u8",
      `/media/clips/${"a".repeat(1100)}`,
    ])
      expect(publicMediaKey(bad), bad).toBeNull();
  });
});

function fakeStorage(objects: Record<string, string>) {
  const calls: { bucket: string; key: string; opts?: GetOptions }[] = [];
  return {
    calls,
    async get(bucket: string, key: string, opts?: GetOptions): Promise<Response | null> {
      calls.push({ bucket, key, opts });
      if (key === "clips/broken.mp4") throw new S3Error(500, "InternalError", "get: InternalError");
      const body = objects[key];
      if (body === undefined) return null;
      if (opts?.range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(opts.range);
        if (!m) throw new S3Error(416, "InvalidRange", "get: InvalidRange");
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : body.length - 1;
        if (start >= body.length) throw new S3Error(416, "InvalidRange", "get: InvalidRange");
        return new Response(body.slice(start, end + 1), {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-range": `bytes ${start}-${end}/${body.length}`,
            etag: '"e1"',
            "x-amz-request-id": "leak",
          },
        });
      }
      return new Response(body, { headers: { "content-type": "video/mp4", etag: '"e1"', "x-amz-request-id": "leak" } });
    },
  };
}

const req = (path: string, init: RequestInit = {}) => new Request(`http://origin.test${path}`, init);

describe("createMediaHandler", () => {
  const storage = fakeStorage({ "clips/c1.mp4": "0123456789", "moderation/ncii-hidden/clips/c1.mp4": "secret" });
  const handle = createMediaHandler({ storage, bucket: "commonair-media" });

  test("GET serves a public object from the media bucket with safe headers", async () => {
    const res = await handle(req("/media/clips/c1.mp4"), "/media/clips/c1.mp4");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
    expect(storage.calls.at(-1)).toEqual({ bucket: "commonair-media", key: "clips/c1.mp4", opts: undefined });
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("etag")).toBe('"e1"');
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-amz-request-id")).toBeNull();
  });

  test("a Range request is passed through and answered 206", async () => {
    const res = await handle(req("/media/clips/c1.mp4", { headers: { range: "bytes=2-4" } }), "/media/clips/c1.mp4");
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("234");
    expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(storage.calls.at(-1)?.opts).toEqual({ range: "bytes=2-4" });
  });

  test("unsatisfiable or multi-part ranges are 416", async () => {
    const past = await handle(req("/media/clips/c1.mp4", { headers: { range: "bytes=50-" } }), "/media/clips/c1.mp4");
    expect(past.status).toBe(416);
    const n = storage.calls.length;
    const multi = await handle(
      req("/media/clips/c1.mp4", { headers: { range: "bytes=0-1,4-5" } }),
      "/media/clips/c1.mp4",
    );
    expect(multi.status).toBe(416);
    expect(storage.calls.length).toBe(n);
  });

  test("HEAD answers headers only", async () => {
    const res = await handle(req("/media/clips/c1.mp4", { method: "HEAD" }), "/media/clips/c1.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("");
  });

  test("private keys are 404 without touching storage, even when the object exists", async () => {
    const n = storage.calls.length;
    for (const path of [
      "/media/moderation/ncii-hidden/clips/c1.mp4",
      "/media/clips/%2e%2e/moderation/ncii-hidden/clips/c1.mp4",
    ]) {
      const res = await handle(req(path), path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(storage.calls.length).toBe(n);
  });

  test("a missing object is 404, a storage failure 502, other methods 405, preflight 204", async () => {
    expect((await handle(req("/media/clips/none.mp4"), "/media/clips/none.mp4")).status).toBe(404);
    expect((await handle(req("/media/clips/broken.mp4"), "/media/clips/broken.mp4")).status).toBe(502);
    const put = await handle(req("/media/clips/c1.mp4", { method: "PUT", body: "x" }), "/media/clips/c1.mp4");
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    const pre = await handle(req("/media/clips/c1.mp4", { method: "OPTIONS" }), "/media/clips/c1.mp4");
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toBe("range");
  });
});
