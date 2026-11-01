// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decision (z): every API path that makes a VOD or clip public or non-public writes
 * `media.vod.state` / `media.clip.state` in its transaction, and every suspension path writes
 * `channel.suspension`. One test per path; DMCA and appeals paths are checked in their own files
 * (`dmca.int.test.ts`, `appeals-e7.int.test.ts`).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { setVodPlacementQueue } from "../src/media/vod-placement-queue.ts";
import { startModeration } from "../src/moderation/index.ts";
import { recordingQueue } from "../src/moderation/queue.ts";
import { mediaStates, suspensions } from "./media-state-helpers.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let api: TestApi;
let mod: User;
let legal1: User;
let legal2: User;
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi({ env: { MODERATION_TEST_HOOKS: "true", MODERATION_CLASSIFIER: "scripted" } });
  // The NCII decision enqueues its hash job on this queue.
  await startModeration(api.deps, { queue: recordingQueue() });
  setVodPlacementQueue(api.deps, { async enqueue() {}, async close() {} });
  [mod, legal1, legal2] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, mod.userId));
  for (const l of [legal1, legal2])
    await db().update(schema.users).set({ role: "legal" }).where(eq(schema.users.id, l.userId));
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

/** A streamer with an ended broadcast, a ready public VOD and a ready clip cut from it. */
async function streamer() {
  const s = await signUpAndSignIn(api);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, s.userId));
  if (!c) throw new Error("no channel");
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ channelId: c.id, ingestProtocol: "rtmp", path: `live/${uuidv7()}`, endedAt: new Date() })
    .returning();
  if (!b) throw new Error("no broadcast");
  const vodId = uuidv7();
  await db()
    .insert(schema.vods)
    .values({
      id: vodId,
      channelId: c.id,
      broadcastId: b.id,
      title: "v",
      storagePrefix: `vods/${vodId}/`,
      status: "ready",
    });
  const clipId = uuidv7();
  await db()
    .insert(schema.clips)
    .values({
      id: clipId,
      channelId: c.id,
      broadcastId: b.id,
      vodId,
      creatorId: s.userId,
      title: "c",
      startOffset: 0,
      durationSeconds: 5,
      status: "ready",
      storageKey: `clips/${clipId}.mp4`,
    });
  return { s, channelId: c.id, broadcastId: b.id, vodId, clipId };
}

const vodStates = (id: string) => mediaStates(db(), "media.vod.state", id);
const clipStates = (id: string) => mediaStates(db(), "media.clip.state", id);

describe("VODs and clips", () => {
  test("vods.update: private hides the VOD and its clip, public shows both again, a rename writes nothing", async () => {
    const o = await streamer();
    const patch = (body: Record<string, unknown>) => o.s.client.call("PATCH", `/api/vods/${o.vodId}`, body);
    expect((await patch({ visibility: "private" })).status).toBe(200);
    expect(await vodStates(o.vodId)).toEqual([[false, "visibility"]]);
    expect(await clipStates(o.clipId)).toEqual([[false, "visibility"]]);
    expect((await patch({ title: "renamed" })).status).toBe(200);
    expect((await patch({ visibility: "subscribers" })).status).toBe(200);
    expect(await vodStates(o.vodId)).toEqual([[false, "visibility"]]);
    expect((await patch({ visibility: "public" })).status).toBe(200);
    expect(await vodStates(o.vodId)).toEqual([
      [false, "visibility"],
      [true, "visibility"],
    ]);
    expect(await clipStates(o.clipId)).toEqual([
      [false, "visibility"],
      [true, "visibility"],
    ]);
  });

  test("vods.remove: the VOD and its clip stop being public", async () => {
    const o = await streamer();
    expect((await o.s.client.call("DELETE", `/api/vods/${o.vodId}`)).status).toBe(200);
    expect(await vodStates(o.vodId)).toEqual([[false, "deleted"]]);
    expect(await clipStates(o.clipId)).toEqual([[false, "deleted"]]);
  });

  test("clips.remove: the clip stops being public; its VOD is untouched", async () => {
    const o = await streamer();
    expect((await o.s.client.call("DELETE", `/api/clips/${o.clipId}`)).status).toBe(200);
    expect(await clipStates(o.clipId)).toEqual([[false, "deleted"]]);
    expect(await vodStates(o.vodId)).toEqual([]);
  });

  test("a report resolved with remove_content: moderation", async () => {
    const o = await streamer();
    const reporter = await signUpAndSignIn(api);
    const r = await reporter.client.call<{ id: string }>("POST", "/api/reports", {
      subjectType: "vod",
      subjectId: o.vodId,
      reason: "spam",
      details: "",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = await mod.client.call("POST", `/api/admin/reports/${r.body.id}`, {
      status: "actioned",
      resolution: "removed",
      action: "remove_content",
      clauseId: "honesty.spam",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await vodStates(o.vodId)).toEqual([[false, "moderation"]]);
    expect(await clipStates(o.clipId)).toEqual([[false, "moderation"]]);
  });

  test("an NCII request decided removed: ncii", async () => {
    const o = await streamer();
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
        deadlineAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: schema.nciiRequests.id });
    await db()
      .insert(schema.nciiRequestItems)
      .values({ requestId: req!.id, url: "https://example.test/x", subjectType: "vod", subjectId: o.vodId });
    const res = await mod.client.call("POST", `/api/admin/ncii/${req!.id}`, { decision: "removed", note: "n" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await vodStates(o.vodId)).toEqual([[false, "ncii"]]);
    expect(await clipStates(o.clipId)).toEqual([[false, "ncii"]]);
  });
});

describe("suspensions", () => {
  const suspend = (who: User, target: "user" | "channel", suspended: boolean) =>
    mod.client.call("POST", `/api/admin/users/${who.username}/suspension`, {
      target,
      suspended,
      reason: "test",
      ...(suspended ? { clauseId: "honesty.spam" } : {}),
    });

  test("safety.suspend on a channel: suspended once, unsuspended once", async () => {
    const o = await streamer();
    expect((await suspend(o.s, "channel", true)).status).toBe(200);
    expect((await suspend(o.s, "channel", true)).status).toBe(200);
    expect(await suspensions(db(), o.channelId)).toEqual([true]);
    expect((await suspend(o.s, "channel", false)).status).toBe(200);
    expect(await suspensions(db(), o.channelId)).toEqual([true, false]);
  });

  test("safety.suspend on the account suspends its channel too", async () => {
    const o = await streamer();
    expect((await suspend(o.s, "user", true)).status).toBe(200);
    expect(await suspensions(db(), o.channelId)).toEqual([true]);
    expect((await suspend(o.s, "user", false)).status).toBe(200);
    expect(await suspensions(db(), o.channelId)).toEqual([true, false]);
  });

  test("a case decided suspend (channel)", async () => {
    const o = await streamer();
    const caseId = uuidv7();
    await db().insert(schema.moderationCases).values({
      id: caseId,
      tier: "t1",
      status: "open",
      origin: "classifier",
      subjectType: "broadcast",
      subjectId: o.broadcastId,
      channelId: o.channelId,
      userId: o.s.userId,
      category: "weapons",
    });
    const res = await mod.client.call("POST", `/api/admin/moderation/cases/${caseId}/review`, {
      decision: "suspend",
      note: "suspended",
      suspendTarget: "channel",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await suspensions(db(), o.channelId)).toEqual([true]);
  });

  test("a T0 dismissal lifts the T0 suspension", async () => {
    const o = await streamer();
    await db()
      .update(schema.users)
      .set({ banned: true, banReason: "t0_hash_match" })
      .where(eq(schema.users.id, o.s.userId));
    await db()
      .update(schema.channels)
      .set({ suspendedAt: new Date(), suspendedReason: "t0_hash_match" })
      .where(eq(schema.channels.id, o.channelId));
    const caseId = uuidv7();
    await db().insert(schema.moderationCases).values({
      id: caseId,
      tier: "t0",
      status: "open",
      origin: "hash_list",
      subjectType: "broadcast",
      subjectId: o.broadcastId,
      channelId: o.channelId,
      userId: o.s.userId,
    });
    const first = await legal1.client.call("POST", `/api/admin/legal/cases/${caseId}/dismiss`, { note: "first" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await suspensions(db(), o.channelId)).toEqual([]);
    const second = await legal2.client.call("POST", `/api/admin/legal/cases/${caseId}/dismiss`, { note: "second" });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await suspensions(db(), o.channelId)).toEqual([false]);
  });
});
