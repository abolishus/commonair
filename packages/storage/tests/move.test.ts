// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { CopyVerificationError, moveVodObjects, S3Error, createS3Storage, type ObjectInfo } from "../src/index.ts";

function fake(handler: (req: Request) => Response) {
  const calls: Request[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return handler(req);
  }) as typeof fetch;
  return { calls, f };
}

const base = {
  endpoint: "http://garage:3900",
  region: "garage",
  accessKeyId: "GK0123",
  secretAccessKey: "s".repeat(64),
  forcePathStyle: true,
};

describe("copy", () => {
  test("sends a signed CopyObject with the encoded source and the COPY directive", async () => {
    const { calls, f } = fake(() => new Response("<CopyObjectResult><ETag>&quot;e&quot;</ETag></CopyObjectResult>"));
    const s = createS3Storage({ ...base, fetch: f });
    await s.copy("media", "recordings/v 1/index.m3u8", "vods/v 1/index.m3u8");
    const req = calls[0]!;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("http://garage:3900/media/vods/v%201/index.m3u8");
    expect(req.headers.get("x-amz-copy-source")).toBe("/media/recordings/v%201/index.m3u8");
    expect(req.headers.get("x-amz-metadata-directive")).toBe("COPY");
    expect(req.headers.get("authorization")).toMatch(/SignedHeaders=[^,]*x-amz-copy-source/);
  });

  test("maps an error status and a 200 carrying an <Error> body", async () => {
    let mode: "404" | "200err" = "404";
    const { f } = fake(() =>
      mode === "404"
        ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
        : new Response("<Error><Code>InternalError</Code></Error>", { status: 200 }),
    );
    const s = createS3Storage({ ...base, fetch: f });
    await expect(s.copy("media", "a", "b")).rejects.toMatchObject({ code: "NoSuchKey", status: 404 });
    mode = "200err";
    await expect(s.copy("media", "a", "b")).rejects.toThrow(S3Error);
    await expect(s.copy("media", "a", "b")).rejects.toMatchObject({ code: "InternalError" });
  });
});

/** In-memory store: enough of the port for moveVodObjects. */
function memory(objects: Record<string, { size: number; etag: string }>, tamper?: (to: string) => ObjectInfo | null) {
  const store = new Map(Object.entries(objects));
  const deleted: string[] = [];
  return {
    store,
    deleted,
    async *list(_bucket: string, prefix: string) {
      for (const [key, o] of [...store].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)))
        yield { key, size: o.size, etag: o.etag, lastModified: new Date(0) };
    },
    async copy(_bucket: string, from: string, to: string) {
      const o = store.get(from);
      if (!o) throw new S3Error(404, "NoSuchKey", "copy");
      store.set(to, { ...o });
    },
    async head(_bucket: string, key: string): Promise<ObjectInfo | null> {
      if (tamper) return tamper(key);
      const o = store.get(key);
      return o ? { key, size: o.size, etag: o.etag, lastModified: new Date(0) } : null;
    },
    async delete(_bucket: string, key: string) {
      deleted.push(key);
      store.delete(key);
    },
  };
}

describe("moveVodObjects", () => {
  const objects = {
    "recordings/v1/index.m3u8": { size: 10, etag: '"a"' },
    "recordings/v1/r1-init.mp4": { size: 20, etag: '"b"' },
    "recordings/v1/r1-0.m4s": { size: 30, etag: '"c"' },
    "recordings/v10/index.m3u8": { size: 1, etag: '"z"' },
  };

  test("copies every object to the same relative key and verifies it; deletes nothing", async () => {
    const m = memory(objects);
    expect(await moveVodObjects(m, "media", "recordings/v1/", "vods/v1/")).toEqual({ copied: 3, bytes: 60 });
    expect([...m.store.keys()].filter((k) => k.startsWith("vods/")).sort()).toEqual([
      "vods/v1/index.m3u8",
      "vods/v1/r1-0.m4s",
      "vods/v1/r1-init.mp4",
    ]);
    // The trailing slash keeps v10 out, and the source stays.
    expect(m.store.has("recordings/v1/index.m3u8")).toBe(true);
    expect(m.deleted).toEqual([]);
  });

  test("an empty source copies nothing", async () => {
    expect(await moveVodObjects(memory({}), "media", "recordings/v1/", "vods/v1/")).toEqual({ copied: 0, bytes: 0 });
  });

  test.each([
    ["missing", () => null],
    ["size", (key: string) => ({ key, size: 999, etag: '"a"', lastModified: new Date(0) })],
    ["etag", (key: string) => ({ key, size: 10, etag: '"other"', lastModified: new Date(0) })],
  ] as const)("a copy that fails verification (%s) throws and keeps the source", async (reason, tamper) => {
    const m = memory(objects, (k) => (k.startsWith("vods/") ? tamper(k) : null));
    await expect(moveVodObjects(m, "media", "recordings/v1/", "vods/v1/")).rejects.toMatchObject({
      name: "CopyVerificationError",
      reason,
    });
    await expect(moveVodObjects(m, "media", "recordings/v1/", "vods/v1/")).rejects.toThrow(CopyVerificationError);
    for (const k of Object.keys(objects)) expect(m.store.has(k)).toBe(true);
    expect(m.deleted).toEqual([]);
  });

  test("ETags compare without quotes or a weak prefix; a store without ETags is checked by size", async () => {
    const quoted = memory({ "recordings/v1/a": { size: 1, etag: '"e"' } }, (key) => ({
      key,
      size: 1,
      etag: 'W/"e"',
      lastModified: new Date(0),
    }));
    await expect(moveVodObjects(quoted, "media", "recordings/v1/", "vods/v1/")).resolves.toEqual({
      copied: 1,
      bytes: 1,
    });
    const none = memory({ "recordings/v1/a": { size: 1, etag: "" } });
    await expect(moveVodObjects(none, "media", "recordings/v1/", "vods/v1/")).resolves.toEqual({ copied: 1, bytes: 1 });
  });

  test("refuses prefixes without a trailing slash, equal or nested ones", async () => {
    const m = memory(objects);
    for (const [from, to] of [
      ["recordings/v1", "vods/v1/"],
      ["recordings/v1/", "vods/v1"],
      ["vods/v1/", "vods/v1/"],
      ["vods/", "vods/v1/"],
      ["vods/v1/", "vods/"],
    ] as const)
      await expect(moveVodObjects(m, "media", from, to)).rejects.toThrow(RangeError);
  });
});
