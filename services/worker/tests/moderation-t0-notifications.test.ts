// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { publishAfterT0 } from "../src/moderation/t0.ts";
import { safeErrorCode } from "../src/moderation/records.ts";
import { selectVodPlaylist } from "../src/moderation/ncii-hash.ts";

describe("T0 post-commit enforcement", () => {
  test("propagates a failed user disconnect so the queue retries", async () => {
    let attempts = 0;
    const ctx = {
      valkey: {
        publish: async () => {
          attempts++;
          if (attempts === 1) throw new Error("redis://private-address/evidence/key");
        },
      },
      logger: { warn: () => undefined },
    } as unknown as WorkerContext;
    const result = { userId: "user-id", ended: null };

    await expect(publishAfterT0(ctx, result, new Date())).rejects.toThrow("private-address");
    await expect(publishAfterT0(ctx, result, new Date())).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  test("propagates a failed live-offline publication after retrying user control", async () => {
    const published: string[] = [];
    const ctx = {
      valkey: {
        del: async () => 0,
        publish: async (channel: string) => {
          published.push(channel);
          if (channel.includes("live")) throw new Error("s3://private/evidence/key");
        },
      },
      logger: { warn: () => undefined },
    } as unknown as WorkerContext;
    await expect(
      publishAfterT0(
        ctx,
        {
          userId: "user-id",
          ended: { broadcastId: "broadcast-id", channelId: "channel-id", slug: "slug", path: "path" },
        },
        new Date(),
      ),
    ).rejects.toThrow("private/evidence/key");
    expect(published).toHaveLength(2);
  });
});

test("NCII VOD objects are retained when no playlist is available", () => {
  expect(() => selectVodPlaylist(["vod/segment-0.ts"])).toThrow("retain source objects");
  expect(selectVodPlaylist(["vod/segment-0.ts", "vod/index.m3u8"])).toBe("vod/index.m3u8");
});

test("error log classification excludes raw messages and URLs", () => {
  expect(safeErrorCode(new Error("https://private.invalid/evidence/object"))).toBe("Error");
  expect(safeErrorCode({ code: "ECONNRESET", message: "s3://private/key" })).toBe("ECONNRESET");
  expect(safeErrorCode({ code: "bad-code-with-data" })).toBe("UnknownError");
});
