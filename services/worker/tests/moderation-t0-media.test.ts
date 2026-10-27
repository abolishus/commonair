// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { ObjectStorage } from "@commonair/storage";
import type { WorkerContext } from "../src/context.ts";
import {
  collectClipTargets,
  collectTargets,
  markT0MediaComplete,
  nextT0MediaSweep,
  preserveOne,
  T0_MEDIA_SWEEP_DELAY_MS,
  t0MediaSweepJobId,
  type MediaTarget,
  type PreserveResult,
} from "../src/moderation/t0-media.ts";
import { t0MediaReconcileJobId } from "../src/moderation/schedules.ts";
import { reconcileT0Media } from "../src/moderation/schedules.ts";
import { t0MediaJobId } from "../src/moderation/t0.ts";
import { t0JobId } from "@commonair/contracts/internal";

const CASE_ID = "0193e6a0-0000-7000-8000-000000000001";
const HOLD_ID = "0193e6a0-0000-7000-8000-000000000002";
const CHANNEL_ID = "0193e6a0-0000-7000-8000-000000000003";

function object(key: string, size = 12) {
  return { key, size, etag: "etag", lastModified: new Date(0) };
}

describe("T0 clip object recovery", () => {
  test("pages past an unfinished first batch so later T0 cases are requeued", async () => {
    const pages = [
      [CASE_ID, HOLD_ID].map((caseId, index) => ({
        caseId,
        holdId: index === 0 ? HOLD_ID : CASE_ID,
        channelId: CHANNEL_ID,
        subjectType: "broadcast" as const,
        subjectId: CHANNEL_ID,
      })),
      [
        { caseId: "0193e6a0-0000-7000-8000-000000000004", holdId: HOLD_ID },
        { caseId: "0193e6a0-0000-7000-8000-000000000005", holdId: HOLD_ID },
      ].map((row) => ({ ...row, channelId: CHANNEL_ID, subjectType: "broadcast" as const, subjectId: CHANNEL_ID })),
      [],
    ];
    let page = 0;
    const enqueued: string[] = [];
    const query = {
      from() {
        return query;
      },
      innerJoin() {
        return query;
      },
      where() {
        return query;
      },
      orderBy() {
        return query;
      },
      async limit() {
        return pages[page++] ?? [];
      },
    };
    const ctx = {
      db: { select: () => query },
      enqueue: async (_queue: string, _name: string, job: { caseId: string }) => enqueued.push(job.caseId),
      now: () => new Date(1_800_000_000_000),
      logger: { error() {} },
    } as unknown as WorkerContext;

    const result = await reconcileT0Media(ctx, 2);

    expect(result).toEqual({ selected: 4, enqueued: 4 });
    expect(enqueued).toEqual(pages.slice(0, 2).flatMap((batch) => batch.map((row) => row.caseId)));
    expect(page).toBe(3);
  });

  test("commits the completion audit and event together once after a clean pass", async () => {
    const writes: string[] = [];
    let complete = false;
    let selects = 0;
    let lockTail = Promise.resolve();
    const tx = {
      async execute() {},
      select() {
        const query = selects++ % 2 === 0 ? "completion" : "flag";
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    if (query === "completion") return complete ? [{ id: "audit-id" }] : [];
                    return [{ listCategory: "csam", provider: "fixture", providerVersion: "fixture-v1" }];
                  },
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          async values(value: unknown) {
            const row = value as { action?: string; type?: string };
            if (row.action === "moderation.t0.media_complete") complete = true;
            writes.push(row.action ? "audit" : row.type ? "event" : "other");
          },
        };
      },
    };
    const ctx = {
      db: {
        async transaction(run: (tx: unknown) => Promise<unknown>) {
          let release: (() => void) | undefined;
          const transaction = {
            ...tx,
            async execute() {
              const previous = lockTail;
              lockTail = new Promise<void>((resolve) => {
                release = resolve;
              });
              await previous;
            },
          };
          try {
            return await run(transaction);
          } finally {
            release?.();
          }
        },
      },
      now: () => new Date(0),
    } as unknown as WorkerContext;
    const job = { caseId: CASE_ID, holdId: HOLD_ID, channelId: CHANNEL_ID, broadcastId: null };

    await Promise.all([
      markT0MediaComplete(ctx, job, { type: "broadcast", id: CHANNEL_ID }),
      markT0MediaComplete(ctx, job, { type: "broadcast", id: CHANNEL_ID }),
    ]);

    expect(writes).toEqual(["audit", "event"]);
  });

  test("daily reconciliation uses a fresh stable job id per run after finite retries exhaust", () => {
    const first = t0MediaReconcileJobId(CASE_ID, 1_800_000_000_000);
    const second = t0MediaReconcileJobId(CASE_ID, 1_800_086_400_000);
    expect(first).toBe(`t0-media-${CASE_ID}-reconcile-1800000000000`);
    expect(second).not.toBe(first);
    expect(nextT0MediaSweep(CASE_ID, first, 1)).toEqual({
      jobId: `${first}-sweep-1`,
      delayMs: T0_MEDIA_SWEEP_DELAY_MS,
    });
    expect(nextT0MediaSweep(CASE_ID, `${first}-sweep-1`, 1)).toEqual({
      jobId: `${first}-sweep-2`,
      delayMs: T0_MEDIA_SWEEP_DELAY_MS,
    });
    expect(nextT0MediaSweep(CASE_ID, `${first}-sweep-1`, 0)).toBeNull();
  });

  test("every t0 job id is one BullMQ accepts (a `:` only in exactly three parts)", () => {
    // bullmq 6 Job.validateOptions: an id containing ":" must split into exactly 3 parts.
    const accepted = (id: string) => !/^\d+$/.test(id) && (!id.includes(":") || id.split(":").length === 3);
    const reconcile = t0MediaReconcileJobId(CASE_ID, 1_800_000_000_000);
    const ids = [
      t0JobId("broadcast", CASE_ID),
      t0MediaJobId(CASE_ID),
      t0MediaSweepJobId(CASE_ID, 3),
      reconcile,
      nextT0MediaSweep(CASE_ID, t0MediaJobId(CASE_ID), 1)?.jobId,
      nextT0MediaSweep(CASE_ID, reconcile, 1)?.jobId,
      nextT0MediaSweep(CASE_ID, `${reconcile}-sweep-4`, 1)?.jobId,
    ];
    for (const id of ids) expect(id !== undefined && accepted(id), String(id)).toBe(true);
  });

  test("keeps delayed reconciliation alive across an upload discovered after the first pass", () => {
    const firstSweep = nextT0MediaSweep(CASE_ID, t0MediaJobId(CASE_ID), 0);
    expect(firstSweep).toEqual({ jobId: t0MediaSweepJobId(CASE_ID, 1), delayMs: T0_MEDIA_SWEEP_DELAY_MS });

    // The recorder's final poll publishes a segment after the first pass; this sweep finds it.
    const secondSweep = nextT0MediaSweep(CASE_ID, firstSweep?.jobId, 1);
    expect(secondSweep).toEqual({ jobId: t0MediaSweepJobId(CASE_ID, 2), delayMs: T0_MEDIA_SWEEP_DELAY_MS });

    // Once a full pass finds no public objects, the durable chain can stop.
    expect(nextT0MediaSweep(CASE_ID, secondSweep?.jobId, 0)).toBeNull();
  });

  test("a VOD's objects are found under both of its own prefixes (a placement move in flight)", async () => {
    const vodId = "0193e6a0-0000-7000-8000-0000000000aa";
    const listed: string[] = [];
    const storage = {
      async *list(_bucket: string, prefix: string) {
        listed.push(prefix);
        const keys: Record<string, string[]> = {
          [`vods/${vodId}/`]: [`vods/${vodId}/index.m3u8`],
          [`recordings/${vodId}/`]: [`recordings/${vodId}/index.m3u8`, `recordings/${vodId}/thumbnail.webp`],
        };
        for (const key of keys[prefix] ?? []) yield object(key);
      },
    } as unknown as ObjectStorage;
    const db = { select: () => ({ from: () => ({ where: async () => [] }) }) };
    const targets = await collectTargets({ db, mediaBucket: "media" } as unknown as WorkerContext, storage, {
      type: "vod",
      id: vodId,
    });
    expect(listed).toEqual([`vods/${vodId}/`, `recordings/${vodId}/`]);
    expect(targets).toEqual([
      { key: `vods/${vodId}/index.m3u8`, kind: "vod_object", sourceType: "vod", sourceId: vodId },
      { key: `recordings/${vodId}/index.m3u8`, kind: "vod_object", sourceType: "vod", sourceId: vodId },
      { key: `recordings/${vodId}/thumbnail.webp`, kind: "thumbnail", sourceType: "vod", sourceId: vodId },
    ]);
  });

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
    let selectNumber = 0;
    let writeNumber = 0;
    const tx = {
      async execute() {
        events.push("transaction-lock");
      },
      select() {
        const current = selectNumber++;
        return {
          from() {
            return {
              where() {
                return Object.assign(Promise.resolve([] as unknown[]), {
                  async limit() {
                    return current === 1
                      ? [{ listCategory: "csam", provider: "fixture", providerVersion: "fixture-v1" }]
                      : [];
                  },
                });
              },
            };
          },
        };
      },
      insert(table: unknown) {
        return {
          async values() {
            void table;
            events.push(["manifest-write", "audit-write", "event-write"][writeNumber++] ?? "unknown-write");
          },
        };
      },
    };
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
        async transaction(run: (tx: unknown) => Promise<unknown>) {
          events.push("transaction-start");
          const result = await run(tx);
          events.push("transaction-commit");
          return result;
        },
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
      "transaction-start",
      "transaction-lock",
      "evidence-write",
      "evidence-verify-read",
      "manifest-write",
      "audit-write",
      "event-write",
      "transaction-commit",
      "source-delete",
    ]);
    expect(objects.has(target.key)).toBe(false);
    expect([...objects.keys()].some((key) => key.startsWith(`evidence/${CASE_ID}/`))).toBe(true);
    expect(acc.copied).toBe(1);
    expect(acc.deleted).toBe(1);
  });
});
