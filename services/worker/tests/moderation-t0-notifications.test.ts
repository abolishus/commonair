// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import type { WorkerContext } from "../src/context.ts";
import { handleT0, publishAfterT0 } from "../src/moderation/t0.ts";
import { safeErrorCode } from "../src/moderation/records.ts";
import { selectVodPlaylist } from "../src/moderation/ncii-hash.ts";

describe("T0 post-commit enforcement", () => {
  test("rolls back every T0 write and skips follow-up actions on evidence key mismatch", async () => {
    const attemptedTables: unknown[] = [];
    const committedTables: unknown[] = [];
    const published: string[] = [];
    const enqueued: string[] = [];
    let selectCount = 0;
    const tx = {
      async execute() {},
      select() {
        const selection = selectCount++;
        const query = {
          from() {
            return query;
          },
          where() {
            return query;
          },
          async for() {
            return [];
          },
          async limit() {
            return [];
          },
        };
        void selection;
        return query;
      },
    };
    const ctx = {
      db: {
        async transaction(run: (tx: unknown) => Promise<unknown>) {
          const pending: unknown[] = [];
          const transaction = {
            ...tx,
            insert(table: unknown) {
              return {
                values() {
                  attemptedTables.push(table);
                  pending.push(table);
                  return Promise.resolve();
                },
              };
            },
          };
          const result = await run(transaction);
          committedTables.push(...pending);
          return result;
        },
      },
      now: () => new Date("2026-10-21T12:00:00.000Z"),
      logger: { error() {}, fatal() {}, warn() {}, info() {} },
      valkey: { publish: async (channel: string) => published.push(channel) },
      enqueue: async (queue: string, name: string) => enqueued.push(`${queue}:${name}`),
      moderation: {
        classifier: { provider: "scripted", providerVersion: "scripted-v1", scored: [], classify: async () => ({}) },
        sealing: { keyId: "11111111111111111111111111111111", seal: async () => new Uint8Array() },
        evidenceStorage: {},
        evidenceBucket: "synthetic-evidence",
        envSampleSeconds: 2,
        testHooks: true,
        t0Retry: { attempts: 1, baseMs: 0, maxMs: 0 },
      },
    } as unknown as WorkerContext;
    const job = {
      subjectType: "upload" as const,
      subjectId: "0193e6a0-0000-7000-8000-000000000004",
      channelId: "0193e6a0-0000-7000-8000-000000000003",
      userId: "0193e6a0-0000-7000-8000-000000000005",
      listCategory: "ncii" as const,
      provider: "pdq:local",
      listVersion: "local:1",
      distance: 0,
      quality: 90,
      capturedAt: "2026-10-21T12:00:00.000Z",
      evidence: [
        {
          kind: "upload" as const,
          contentType: "image/png" as const,
          sealedBase64: Buffer.from("synthetic sealed fixture bytes").toString("base64"),
          sha256: "a".repeat(64),
          sizeBytes: 10,
          keyId: "22222222222222222222222222222222",
          pdq: null,
          pdqQuality: null,
          capturedAt: "2026-10-21T12:00:00.000Z",
        },
      ],
    };

    await expect(handleT0(ctx, job, { attemptsMade: 0 })).rejects.toThrow("T0 evidence key does not match");

    expect(committedTables).toEqual([]);
    expect(attemptedTables).toEqual([schema.moderationCases, schema.legalHolds]);
    expect(attemptedTables).not.toContain(schema.evidenceObjects);
    expect(committedTables).not.toContain(schema.evidenceObjects);
    expect(published).toEqual([]);
    expect(enqueued).toEqual([]);
  });

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
