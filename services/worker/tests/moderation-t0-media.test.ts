// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { ObjectStorage } from "@commonair/storage";
import type { WorkerContext } from "../src/context.ts";
import { collectClipTargets, preserveOne, type MediaTarget, type PreserveResult } from "../src/moderation/t0-media.ts";

const CASE_ID = "0193e6a0-0000-7000-8000-000000000001";
const HOLD_ID = "0193e6a0-0000-7000-8000-000000000002";
const CHANNEL_ID = "0193e6a0-0000-7000-8000-000000000003";

function object(key: string, size = 12) {
  return { key, size, etag: "etag", lastModified: new Date(0) };
}

describe("T0 clip object recovery", () => {
  test("lists deterministic clip prefixes and classifies orphan MP4 and image objects", async () => {
    const listed: string[] = [];
    const storage = {
      async *list(_bucket: string, prefix: string) {
        listed.push(prefix);
        const keys =
          prefix === "clips/clip-a."
            ? ["clips/clip-a.mp4", "clips/clip-a.webp", "clips/clip-a.tmp"]
            : ["clips/clip-b.mp4", "clips/clip-b.jpg"];
        for (const key of keys) yield object(key);
      },
    } as unknown as ObjectStorage;
    const targets = await collectClipTargets(storage, "media", [
      { id: "clip-a", storageKey: null, thumbnailKey: null },
      { id: "clip-b", storageKey: "clips/clip-b.mp4", thumbnailKey: "clips/clip-b.jpg" },
    ]);

    expect(listed).toEqual(["clips/clip-a.", "clips/clip-b."]);
    expect(targets).toEqual([
      { key: "clips/clip-a.mp4", kind: "clip_object", sourceType: "clip", sourceId: "clip-a" },
      { key: "clips/clip-a.webp", kind: "thumbnail", sourceType: "clip", sourceId: "clip-a" },
      { key: "clips/clip-b.mp4", kind: "clip_object", sourceType: "clip", sourceId: "clip-b" },
      { key: "clips/clip-b.jpg", kind: "thumbnail", sourceType: "clip", sourceId: "clip-b" },
    ]);
  });

  test("verifies evidence and records its manifest before deleting an orphan public object", async () => {
    const events: string[] = [];
    const objects = new Map<string, Uint8Array>([["clips/clip-orphan.mp4", new Uint8Array([1, 2, 3, 4])]]);
    const storage = {
      async get(_bucket: string, key: string) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        events.push(key === "clips/clip-orphan.mp4" ? "source-read" : "evidence-verify-read");
        return new Response(Buffer.from(bytes), { headers: { "content-type": "video/mp4" } });
      },
      async put(_bucket: string, key: string, body: BodyInit) {
        events.push("evidence-write");
        objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
      },
      async delete(_bucket: string, key: string) {
        events.push("source-delete");
        objects.delete(key);
      },
    } as unknown as ObjectStorage;
    const ctx = {
      storage,
      mediaBucket: "media",
      moderation: {
        evidenceStorage: storage,
        evidenceBucket: "evidence",
        sealing: {
          keyId: "test-key",
          async seal(bytes: Uint8Array) {
            return new Uint8Array([...bytes, 9]);
          },
        },
      },
      db: {
        select: () => ({ from: () => ({ where: async () => [] }) }),
        insert: () => ({ values: async () => events.push("manifest-write") }),
      },
      now: () => new Date(0),
    } as unknown as WorkerContext;
    const target: MediaTarget = {
      key: "clips/clip-orphan.mp4",
      kind: "clip_object",
      sourceType: "clip",
      sourceId: "clip-orphan",
    };
    const acc: PreserveResult = { copied: 0, alreadyPreserved: 0, deleted: 0, evidenceIds: [] };

    await preserveOne(ctx, { caseId: CASE_ID, holdId: HOLD_ID, channelId: CHANNEL_ID, broadcastId: null }, target, acc);

    expect(events).toEqual([
      "source-read",
      "evidence-write",
      "evidence-verify-read",
      "manifest-write",
      "source-delete",
    ]);
    expect(objects.has(target.key)).toBe(false);
    expect([...objects.keys()].some((key) => key.startsWith(`evidence/${CASE_ID}/`))).toBe(true);
    expect(acc.copied).toBe(1);
    expect(acc.deleted).toBe(1);
  });
});
