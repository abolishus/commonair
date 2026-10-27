// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vod-placement` (ADR 0009 amendment 1, decision 3; docs/testing/w0-selectors.md "VOD states")
 * against the stack's Postgres, Valkey and Garage: every state's target, `leave`, idempotence, a
 * crash between copy and commit or after commit, a state change during the copy, the per-VOD lock,
 * and the sweep (batching, the legacy `vods/` migration, what it never selects).
 */
import { vodPrefix } from "@commonair/contracts/storage";
import { schema, uuidv7 } from "@commonair/db";
import { moveVodObjects, type ObjectStorage } from "@commonair/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { job as placementJob } from "../src/jobs/vod-placement.ts";
import {
  misplacedVods,
  placeVod,
  sweepVodPlacement,
  vodPlacementJobId,
  vodPlacementLockKey,
} from "../src/vod/placement.ts";
import { MEDIA_BUCKET, stackStorage } from "./e6-fixtures.ts";
import { makeBroadcast, makeUser, setup, type TestEnv } from "./fixtures.ts";

const storage = stackStorage();
let env: TestEnv;

const FILES = ["index.m3u8", "init_r1.mp4", "r1_000000.m4s", "r1_000001.m4s", "thumbnail.webp"];

describe.skipIf(!storage)("vod-placement", () => {
  const S3 = storage as ObjectStorage;
  let channelId: string;
  let ownerId: string;
  let broadcastId: string;

  beforeAll(async () => {
    env = await setup({ jobs: [], outbox: false, segments: false, storage: S3, mediaBucket: MEDIA_BUCKET });
  });
  afterAll(() => env?.close());
  beforeEach(async () => {
    const { user, channel } = await makeUser(env.t.db);
    ownerId = user.id;
    channelId = channel.id;
    broadcastId = (await makeBroadcast(env.t.db, channelId)).id;
  });

  const ctx = (): WorkerContext => env.worker.ctx;
  const db = () => env.t.db;

  async function list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const o of S3.list(MEDIA_BUCKET, prefix)) keys.push(o.key.slice(prefix.length));
    return keys.sort();
  }

  /** A VOD row with its objects under `at` (the row says so too unless `rowPrefix` differs). */
  async function makeVod(
    over: Partial<typeof schema.vods.$inferInsert> = {},
    at: "public" | "private" = "private",
  ): Promise<string> {
    const id = over.id ?? uuidv7();
    const prefix = vodPrefix(id, at);
    for (const f of FILES)
      await S3.put(MEDIA_BUCKET, prefix + f, `${f} of ${id}`, {
        contentType: f.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
      });
    await db()
      .insert(schema.vods)
      .values({
        id,
        broadcastId,
        channelId,
        title: "v",
        status: "ready",
        storagePrefix: prefix,
        thumbnailKey: `${prefix}thumbnail.webp`,
        ...over,
      });
    return id;
  }

  const row = async (id: string) => (await db().select().from(schema.vods).where(eq(schema.vods.id, id)))[0]!;

  async function expectAt(id: string, placement: "public" | "private") {
    const other = placement === "public" ? "private" : "public";
    const r = await row(id);
    expect(r.storagePrefix).toBe(vodPrefix(id, placement));
    expect(r.thumbnailKey).toBe(`${vodPrefix(id, placement)}thumbnail.webp`);
    expect(await list(vodPrefix(id, placement))).toEqual([...FILES].sort());
    expect(await list(vodPrefix(id, other))).toEqual([]);
    expect(await (await S3.get(MEDIA_BUCKET, `${vodPrefix(id, placement)}index.m3u8`))?.text()).toBe(
      `index.m3u8 of ${id}`,
    );
  }

  describe("one VOD", () => {
    test("a ready public VOD under recordings/ moves to vods/ (thumbnail key rebased)", async () => {
      const id = await makeVod();
      expect(await placeVod(ctx(), id)).toEqual({ outcome: "moved", objects: FILES.length });
      await expectAt(id, "public");
      // Content type survives the server-side copy.
      expect((await S3.get(MEDIA_BUCKET, `vods/${id}/index.m3u8`))?.headers.get("content-type")).toBe(
        "application/vnd.apple.mpegurl",
      );
    });

    test.each([
      ["subscribers", { visibility: "subscribers" as const }],
      ["private", { visibility: "private" as const }],
      ["owner-removed", { removedReason: "owner", expiresAt: new Date() }],
      ["dmca-removed (objects not hidden by a takedown item)", { removedReason: "dmca" }],
      ["failed", { status: "failed" as const }],
    ])("a %s VOD under vods/ moves to recordings/", async (_name, over) => {
      const id = await makeVod(over, "public");
      expect(await placeVod(ctx(), id)).toMatchObject({ outcome: "moved" });
      await expectAt(id, "private");
    });

    test("a T1-restricted broadcast's VOD and a suspended channel's VOD move to recordings/", async () => {
      const restricted = await makeVod({}, "public");
      await db()
        .update(schema.broadcasts)
        .set({ restrictedAt: new Date() })
        .where(eq(schema.broadcasts.id, broadcastId));
      expect(await placeVod(ctx(), restricted)).toMatchObject({ outcome: "moved" });
      await expectAt(restricted, "private");

      const other = await makeUser(env.t.db);
      const b2 = await makeBroadcast(env.t.db, other.channel.id);
      const suspended = await makeVod({ channelId: other.channel.id, broadcastId: b2.id }, "public");
      await db()
        .update(schema.channels)
        .set({ suspendedAt: new Date() })
        .where(eq(schema.channels.id, other.channel.id));
      expect(await placeVod(ctx(), suspended)).toMatchObject({ outcome: "moved" });
      await expectAt(suspended, "private");
      // Lifting the restriction brings it back.
      await db().update(schema.broadcasts).set({ restrictedAt: null }).where(eq(schema.broadcasts.id, broadcastId));
      expect(await placeVod(ctx(), restricted)).toMatchObject({ outcome: "moved" });
      await expectAt(restricted, "public");
    });

    test("a legal hold on the owner never blocks moving to private", async () => {
      await db()
        .insert(schema.legalHolds)
        .values({ userId: ownerId, reasonCode: "law_enforcement", reason: "preservation request" });
      const id = await makeVod({ removedReason: "owner", expiresAt: new Date() }, "public");
      expect(await placeVod(ctx(), id)).toMatchObject({ outcome: "moved" });
      await expectAt(id, "private");
    });

    test("idempotent: a second run finds it in place and changes nothing", async () => {
      const id = await makeVod({ visibility: "subscribers" }, "public");
      await placeVod(ctx(), id);
      expect(await placeVod(ctx(), id)).toEqual({ outcome: "in_place", objects: 0 });
      await expectAt(id, "private");
    });

    test("a crash between copy and commit: the rerun finishes the move", async () => {
      const id = await makeVod({ visibility: "private" }, "public");
      // What a crashed run left: complete copies, the row and the source unchanged.
      await moveVodObjects(S3, MEDIA_BUCKET, vodPrefix(id, "public"), vodPrefix(id, "private"));
      expect((await row(id)).storagePrefix).toBe(vodPrefix(id, "public"));
      expect(await placeVod(ctx(), id)).toMatchObject({ outcome: "moved" });
      await expectAt(id, "private");
    });

    test("a crash after commit: the rerun deletes the stray source copies", async () => {
      const id = await makeVod({ visibility: "private" }, "public");
      await moveVodObjects(S3, MEDIA_BUCKET, vodPrefix(id, "public"), vodPrefix(id, "private"));
      await db()
        .update(schema.vods)
        .set({ storagePrefix: vodPrefix(id, "private"), thumbnailKey: `${vodPrefix(id, "private")}thumbnail.webp` })
        .where(eq(schema.vods.id, id));
      expect(await placeVod(ctx(), id)).toEqual({ outcome: "in_place", objects: FILES.length });
      await expectAt(id, "private");
    });

    test("a state change during the copy: nothing is switched, the copies go, the next run decides", async () => {
      const id = await makeVod({}, "private");
      let changed = false;
      const racing = new Proxy(S3, {
        get(target, prop) {
          if (prop === "copy")
            return async (bucket: string, from: string, to: string) => {
              if (!changed) {
                changed = true;
                await db().update(schema.vods).set({ visibility: "subscribers" }).where(eq(schema.vods.id, id));
              }
              return target.copy(bucket, from, to);
            };
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const c = { ...ctx(), storage: racing };
      expect(await placeVod(c, id)).toEqual({ outcome: "raced", objects: 0 });
      await expectAt(id, "private");
      expect(await placeVod(c, id)).toMatchObject({ outcome: "in_place" });
    });

    test("leave: NCII-hidden, DMCA-hidden (until restored) and deleted VODs are not moved", async () => {
      const ncii = await makeVod({ visibility: "subscribers" }, "public");
      const [req] = await db()
        .insert(schema.nciiRequests)
        .values({
          requesterName: "r",
          requesterEmail: "r@example.test",
          relationship: "self",
          contentUrls: ["https://example.test/x"],
          description: "d",
          goodFaith: true,
          signature: "r",
          deadlineAt: new Date(0),
        })
        .returning();
      await db()
        .insert(schema.nciiRequestItems)
        .values({
          requestId: req!.id,
          url: "https://example.test/x",
          subjectType: "vod",
          subjectId: ncii,
          hiddenAt: new Date(),
        });

      const dmca = await makeVod({ removedReason: "dmca" }, "public");
      const [notice] = await db()
        .insert(schema.dmcaNotices)
        .values({
          claimantName: "c",
          claimantEmail: "c@example.test",
          claimantAddress: "a",
          copyrightedWork: "w",
          infringingUrls: ["https://example.test/v"],
          goodFaithStatement: true,
          accuracyStatement: true,
          signature: "c",
          status: "actioned",
          actionedAt: new Date(),
        })
        .returning();
      const [item] = await db()
        .insert(schema.dmcaNoticeItems)
        .values({
          noticeId: notice!.id,
          url: "https://example.test/v",
          subjectType: "broadcast",
          subjectId: broadcastId,
          ownerId,
          channelId,
          removedAt: new Date(),
        })
        .returning();
      const deleted = await makeVod({ status: "deleted", removedReason: "t0_hash_match" }, "public");

      for (const id of [ncii, dmca, deleted]) {
        expect(await placeVod(ctx(), id)).toEqual({ outcome: "left", objects: 0 });
        expect((await row(id)).storagePrefix).toBe(vodPrefix(id, "public"));
        expect(await list(vodPrefix(id, "public"))).toEqual([...FILES].sort());
      }
      for (const id of [ncii, dmca, deleted]) expect(await misplacedVods(db(), 10_000)).not.toContain(id);

      // Restored: the takedown no longer owns the keys, and the VOD (still removed) goes private.
      await db()
        .update(schema.dmcaNoticeItems)
        .set({ restoredAt: new Date() })
        .where(eq(schema.dmcaNoticeItems.id, item!.id));
      expect(await placeVod(ctx(), dmca)).toMatchObject({ outcome: "moved" });
      await expectAt(dmca, "private");
    });

    test("recording and processing VODs belong to finalize; a foreign prefix is refused; a missing VOD is a no-op", async () => {
      const recording = await makeVod({ status: "recording" }, "public");
      const processing = await makeVod({ status: "processing" }, "public");
      expect(await placeVod(ctx(), recording)).toEqual({ outcome: "finalizing", objects: 0 });
      expect(await placeVod(ctx(), processing)).toEqual({ outcome: "finalizing", objects: 0 });
      const foreignId = uuidv7();
      await db()
        .insert(schema.vods)
        .values({ id: foreignId, broadcastId, channelId, title: "v", status: "ready", storagePrefix: "vods/" });
      expect(await placeVod(ctx(), foreignId)).toEqual({ outcome: "refused", objects: 0 });
      expect(await placeVod(ctx(), uuidv7())).toEqual({ outcome: "missing", objects: 0 });
      for (const id of [recording, processing, foreignId]) expect(await misplacedVods(db(), 10_000)).not.toContain(id);
    });

    test("one move at a time per VOD: a held lock answers busy", async () => {
      const id = await makeVod({ visibility: "private" }, "public");
      await ctx().valkey.set(vodPlacementLockKey(id), "other", "PX", 30_000);
      try {
        expect(await placeVod(ctx(), id)).toEqual({ outcome: "busy", objects: 0 });
        expect((await row(id)).storagePrefix).toBe(vodPrefix(id, "public"));
      } finally {
        await ctx().valkey.del(vodPlacementLockKey(id));
      }
    });

    test("the job runs one VOD with data and the sweep without", async () => {
      const id = await makeVod({ visibility: "private" }, "public");
      expect(await placementJob.handler({ vodId: id }, ctx(), { id: "x", attemptsMade: 0 })).toEqual({
        moved: 1,
        objects: FILES.length,
      });
      await expectAt(id, "private");
    });
  });

  describe("sweep", () => {
    test("selects misplaced VODs in batches, migrates legacy vods/ objects, and enqueues one job each", async () => {
      // A clean database for exact counts.
      await db().delete(schema.vods);
      const legacy = [
        await makeVod({ visibility: "subscribers" }, "public"),
        await makeVod({ visibility: "private" }, "public"),
        await makeVod({ removedReason: "owner" }, "public"),
      ];
      const wantPublic = await makeVod({}, "private");
      const fine = [await makeVod({}, "public"), await makeVod({ visibility: "subscribers" }, "private")];

      const all = await misplacedVods(db(), 10_000);
      expect(all.sort()).toEqual([...legacy, wantPublic].sort());
      for (const id of fine) expect(all).not.toContain(id);
      expect(await misplacedVods(db(), 2)).toHaveLength(2);

      const enqueued: { name: string; data: unknown; jobId?: string }[] = [];
      const c: WorkerContext = {
        ...ctx(),
        enqueueBulk: async (_queue, jobs) => {
          for (const j of jobs) enqueued.push({ name: j.name, data: j.data, jobId: j.opts?.jobId });
        },
      };
      expect(await sweepVodPlacement(c, 2)).toEqual({ enqueued: 2 });
      const at = c.now();
      expect(enqueued).toEqual(
        all
          .sort()
          .slice(0, 2)
          .map((vodId) => ({ name: "vod-placement", data: { vodId }, jobId: vodPlacementJobId(vodId, at) })),
      );
      // BullMQ refuses custom ids with a single ':'.
      for (const e of enqueued) expect(e.jobId).not.toContain(":");

      // Run every job the sweeps enqueue until nothing is misplaced.
      for (let round = 0; round < 5 && (await misplacedVods(db(), 10_000)).length > 0; round++) {
        enqueued.length = 0;
        await sweepVodPlacement(c, 2);
        for (const e of enqueued) await placeVod(ctx(), (e.data as { vodId: string }).vodId);
      }
      expect(await misplacedVods(db(), 10_000)).toEqual([]);
      for (const id of legacy) await expectAt(id, "private");
      await expectAt(wantPublic, "public");
      // No object of a non-public VOD is under vods/.
      for (const id of [...legacy, fine[1]!]) expect(await list(vodPrefix(id, "public"))).toEqual([]);
    });
  });
});
