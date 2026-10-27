// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `copy` (S3 CopyObject) and `moveVodObjects` against the stack's object store at the `.env`
 * settings (the pinned Garage image today; ADR 0009 amendment 1 requires this proof). Skipped when
 * the S3 variables are not set. Every key lives under a per-run prefix and is deleted afterwards.
 */
import { afterAll, describe, expect, test } from "vite-plus/test";
import { createS3Storage, moveVodObjects, S3Error, type ObjectStorage } from "../src/index.ts";

const { S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
const BUCKET = process.env.S3_BUCKET_MEDIA ?? "commonair-media";
const storage: ObjectStorage | null =
  S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY
    ? createS3Storage({
        endpoint: S3_ENDPOINT,
        region: process.env.S3_REGION ?? "garage",
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY,
        forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
      })
    : null;
const run = `storage-int-${crypto.randomUUID()}`;

describe.skipIf(!storage)("S3 copy against the stack's store", () => {
  const s = storage as ObjectStorage;
  afterAll(async () => {
    await s.deletePrefix(BUCKET, `${run}/`);
  });

  test("CopyObject copies bytes server side and keeps content type and cache-control", async () => {
    const body = new Uint8Array(Array.from({ length: 70_000 }, (_, i) => i % 251));
    await s.put(BUCKET, `${run}/a/seg 1.m4s`, body, { contentType: "video/iso.segment", cacheControl: "no-cache" });
    await s.copy(BUCKET, `${run}/a/seg 1.m4s`, `${run}/b/seg 1.m4s`);
    const res = await s.get(BUCKET, `${run}/b/seg 1.m4s`);
    expect(res).not.toBeNull();
    expect(res?.headers.get("content-type")).toBe("video/iso.segment");
    expect(res?.headers.get("cache-control")).toBe("no-cache");
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(body);
    const [src, dst] = [await s.head(BUCKET, `${run}/a/seg 1.m4s`), await s.head(BUCKET, `${run}/b/seg 1.m4s`)];
    expect(dst?.size).toBe(src?.size);
    expect(dst?.etag).toBe(src?.etag);
  });

  test("copying a missing source is an S3Error", async () => {
    await expect(s.copy(BUCKET, `${run}/missing`, `${run}/x`)).rejects.toThrow(S3Error);
    expect(await s.head(BUCKET, `${run}/x`)).toBeNull();
  });

  test("moveVodObjects copies a whole prefix and keeps the source", async () => {
    const from = `${run}/recordings/v1/`;
    const to = `${run}/vods/v1/`;
    await s.put(BUCKET, `${from}index.m3u8`, "#EXTM3U\n", { contentType: "application/vnd.apple.mpegurl" });
    await s.put(BUCKET, `${from}r1-init.mp4`, new Uint8Array(100), { contentType: "video/mp4" });
    await s.put(BUCKET, `${from}r1-0.m4s`, new Uint8Array(5000), { contentType: "video/iso.segment" });
    await s.put(BUCKET, `${run}/recordings/v10/index.m3u8`, "other");
    expect(await moveVodObjects(s, BUCKET, from, to)).toEqual({ copied: 3, bytes: 5108 });
    const copied: string[] = [];
    for await (const o of s.list(BUCKET, to)) copied.push(o.key.slice(to.length));
    expect(copied.sort()).toEqual(["index.m3u8", "r1-0.m4s", "r1-init.mp4"]);
    expect(await s.head(BUCKET, `${from}index.m3u8`)).not.toBeNull();
    expect(await (await s.get(BUCKET, `${to}index.m3u8`))?.text()).toBe("#EXTM3U\n");
  });
});
