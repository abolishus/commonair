// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Captions in the API (ADR 0011): `captionTracksFor` / `captionsStateFor` through `playback.start`,
 * `Vod.captions`, and `vods.captions.{get,update}` (visibility, owner and editor permissions,
 * masking re-applied, `caption_edits` by user id, the stored track rewritten). Track rows and the
 * `.vtt` object are seeded as the media worker leaves them.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { MASK_TOKEN, parseVtt, vodVttDocument } from "@commonair/captions";
import { vodCaptionsKey, vodPrefix } from "@commonair/contracts/storage";
import { schema, uuidv7 } from "@commonair/db";
import { captionsStateFor, captionTracksFor } from "../src/captions/tracks.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let owner: User;
let editor: User;
let moderator: User;
let stranger: User;
let channelId: string;
const db = () => api.db.db;
const BUCKET = () => api.deps.env.S3_BUCKET_MEDIA;
const ORIGIN = Date.parse("2026-11-01T12:00:00.000Z");

interface Caps {
  vodId: string;
  language: string;
  status: string;
  cues: { index: number; startMs: number; endMs: number; text: string }[];
  editedAt: string | null;
}

async function broadcast(over: Partial<typeof schema.broadcasts.$inferInsert> = {}) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ channelId, ingestProtocol: "rtmp", path: `live/${uuidv7()}`, ...over })
    .returning();
  return b!;
}

/** A VOD with a ready English track, as media stitches it. */
async function vodWithTrack(
  over: Partial<typeof schema.vods.$inferInsert> = {},
  placement: "private" | "public" = "private",
) {
  const b = await broadcast({ endedAt: new Date() });
  const id = uuidv7();
  const storagePrefix = vodPrefix(id, placement);
  await db()
    .insert(schema.vods)
    .values({
      id,
      channelId,
      broadcastId: b.id,
      title: "v",
      storagePrefix,
      status: "ready",
      durationSeconds: 60,
      ...over,
    });
  const key = vodCaptionsKey(storagePrefix, "en");
  await api.deps.storage.put(
    BUCKET(),
    key,
    vodVttDocument({
      originMs: ORIGIN,
      cues: [
        { startMs: 0, endMs: 1500, text: "helo world" },
        { startMs: 2000, endMs: 3500, text: `this is ${MASK_TOKEN}` },
        { startMs: 4000, endMs: 5000, text: "third" },
      ],
    }),
    { contentType: "text/vtt; charset=utf-8" },
  );
  const [t] = await db()
    .insert(schema.broadcastCaptionTracks)
    .values({ broadcastId: b.id, vodId: id, language: "en", status: "ready", storageKey: key, cueCount: 3 })
    .returning();
  return { id, broadcastId: b.id, key, trackId: t!.id, storagePrefix };
}

beforeAll(async () => {
  api = await startApi();
  [owner, editor, moderator, stranger] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
  channelId = c!.id;
  await db()
    .update(schema.channels)
    .set({ captionsSettings: { enabled: true, spokenLanguage: null, maskWords: ["darn"] } })
    .where(eq(schema.channels.id, channelId));
  await db()
    .insert(schema.channelRoles)
    .values([
      { channelId, userId: editor.userId, role: "editor" },
      { channelId, userId: moderator.userId, role: "moderator" },
    ]);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("live tracks", () => {
  test("active only, never for a rehearsal; the state says why there are none", async () => {
    const b = await broadcast();
    expect(await captionTracksFor(api.deps, b)).toEqual([]);
    expect(await captionsStateFor(api.deps, b)).toBe("off");
    await db().insert(schema.broadcastCaptionTracks).values({ broadcastId: b.id, language: "en", status: "queued" });
    expect(await captionTracksFor(api.deps, b)).toEqual([]);
    expect(await captionsStateFor(api.deps, b)).toBe("queued");
    await db()
      .update(schema.broadcastCaptionTracks)
      .set({ status: "active" })
      .where(eq(schema.broadcastCaptionTracks.broadcastId, b.id));
    expect(await captionTracksFor(api.deps, b)).toEqual([
      { language: "en", label: "English", url: "captions/en/index.m3u8" },
    ]);
    expect(await captionsStateFor(api.deps, b)).toBe("active");
    const rehearsal = { ...b, kind: "rehearsal" as const };
    expect(await captionTracksFor(api.deps, rehearsal)).toEqual([]);
    expect(await captionsStateFor(api.deps, rehearsal)).toBe("off");
  });

  test("playback.start carries them", async () => {
    const b = await broadcast();
    await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, channelId));
    await db().insert(schema.broadcastCaptionTracks).values({ broadcastId: b.id, language: "en", status: "active" });
    const res = await client(api).call<{ captions: unknown[]; captionsState: string }>(
      "POST",
      `/api/channels/${owner.username}/playback`,
      { deviceId: "d".repeat(16) },
    );
    expect(res.status).toBe(200);
    expect(res.body.captionsState).toBe("active");
    expect(res.body.captions).toEqual([{ language: "en", label: "English", url: "captions/en/index.m3u8" }]);
    await db().update(schema.channels).set({ liveBroadcastId: null }).where(eq(schema.channels.id, channelId));
    await db().update(schema.broadcasts).set({ endedAt: new Date() }).where(eq(schema.broadcasts.id, b.id));
  });
});

describe("VOD tracks", () => {
  test("Vod.captions lists ready tracks with a URL on the VOD's own route", async () => {
    const v = await vodWithTrack();
    const res = await owner.client.call<{ captions: { language: string; url: string }[] }>("GET", `/api/vods/${v.id}`);
    expect(res.status).toBe(200);
    expect(res.body.captions).toHaveLength(1);
    const url = new URL(res.body.captions[0]!.url);
    expect(url.pathname).toBe(`/vod/${v.id}/captions/en.vtt`);
    expect(url.searchParams.get("t")).toBeTruthy();

    const pub = await vodWithTrack({ visibility: "public" }, "public");
    const pubRes = await client(api).call<{ captions: { url: string }[] }>("GET", `/api/vods/${pub.id}`);
    expect(pubRes.body.captions[0]?.url).toContain(`${vodPrefix(pub.id, "public")}captions/en.vtt`);
  });

  test("get follows the VOD's visibility", async () => {
    const v = await vodWithTrack({ visibility: "private" });
    const mine = await owner.client.call<Caps>("GET", `/api/vods/${v.id}/captions/en`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ vodId: v.id, language: "en", status: "ready", editedAt: null });
    expect(mine.body.cues.map((c) => [c.index, c.startMs, c.endMs, c.text])).toEqual([
      [0, 0, 1500, "helo world"],
      [1, 2000, 3500, `this is ${MASK_TOKEN}`],
      [2, 4000, 5000, "third"],
    ]);
    expect((await stranger.client.call("GET", `/api/vods/${v.id}/captions/en`)).status).toBe(404);
    expect((await client(api).call("GET", `/api/vods/${v.id}/captions/en`)).status).toBe(404);
    await db().update(schema.vods).set({ visibility: "public" }).where(eq(schema.vods.id, v.id));
    expect((await client(api).call("GET", `/api/vods/${v.id}/captions/en`)).status).toBe(200);
    expect((await client(api).call("GET", `/api/vods/${v.id}/captions/es`)).status).toBe(404);
  });

  test("update: owner and editors only; text only, masked again, edits by user id, track rewritten", async () => {
    const v = await vodWithTrack();
    const body = { cues: [{ index: 0, text: "hello  world, darn" }] };
    for (const who of [stranger, moderator])
      expect((await who.client.call("PATCH", `/api/vods/${v.id}/captions/en`, body)).status).toBe(404);
    expect((await client(api).call("PATCH", `/api/vods/${v.id}/captions/en`, body)).status).toBe(401);

    const res = await editor.client.call<Caps>("PATCH", `/api/vods/${v.id}/captions/en`, body);
    expect(res.status).toBe(200);
    expect(res.body.cues[0]).toEqual({ index: 0, startMs: 0, endMs: 1500, text: `hello world, ${MASK_TOKEN}` });
    expect(res.body.editedAt).not.toBeNull();
    // The stored track: same timing, new text, origin kept, nothing unmasked.
    const stored = await (await api.deps.storage.get(BUCKET(), v.key))!.text();
    expect(stored).not.toContain("darn");
    expect(parseVtt(stored)).toEqual({
      originMs: ORIGIN,
      cues: [
        { startMs: 0, endMs: 1500, text: `hello world, ${MASK_TOKEN}` },
        { startMs: 2000, endMs: 3500, text: `this is ${MASK_TOKEN}` },
        { startMs: 4000, endMs: 5000, text: "third" },
      ],
    });
    const edits = await db().select().from(schema.captionEdits).where(eq(schema.captionEdits.trackId, v.trackId));
    expect(edits.map((e) => [e.editorUserId, e.cuesChanged])).toEqual([[editor.userId, 1]]);
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "vod.captions.update"), eq(schema.auditLog.subjectId, v.id)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]?.details)).not.toContain("hello");

    // Unchanged text is not an edit; the owner can edit too.
    const same = await owner.client.call<Caps>("PATCH", `/api/vods/${v.id}/captions/en`, {
      cues: [{ index: 2, text: "third" }],
    });
    expect(same.status).toBe(200);
    expect(
      await db().select().from(schema.captionEdits).where(eq(schema.captionEdits.trackId, v.trackId)),
    ).toHaveLength(1);
    const two = await owner.client.call<Caps>("PATCH", `/api/vods/${v.id}/captions/en`, {
      cues: [
        { index: 1, text: "this is fine" },
        { index: 2, text: "Third." },
      ],
    });
    expect(two.body.cues.map((c) => c.text)).toEqual([`hello world, ${MASK_TOKEN}`, "this is fine", "Third."]);
    const after = await db().select().from(schema.captionEdits).where(eq(schema.captionEdits.trackId, v.trackId));
    expect(after.map((e) => e.cuesChanged).sort((x, y) => x - y)).toEqual([1, 2]);
  });

  test("update refuses unknown or repeated cues, and tracks that are not ready", async () => {
    const v = await vodWithTrack();
    const path = `/api/vods/${v.id}/captions/en`;
    expect((await owner.client.call("PATCH", path, { cues: [{ index: 9, text: "x" }] })).status).toBe(400);
    expect(
      (
        await owner.client.call("PATCH", path, {
          cues: [
            { index: 0, text: "a" },
            { index: 0, text: "b" },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await owner.client.call("PATCH", `/api/vods/${v.id}/captions/es`, { cues: [{ index: 0, text: "x" }] })).status,
    ).toBe(404);
    await db()
      .update(schema.broadcastCaptionTracks)
      .set({ status: "failed" })
      .where(eq(schema.broadcastCaptionTracks.id, v.trackId));
    expect((await owner.client.call("PATCH", path, { cues: [{ index: 0, text: "x" }] })).status).toBe(412);
    const got = await owner.client.call<Caps>("GET", path);
    expect(got.body).toMatchObject({ status: "failed", cues: [] });
  });
});
