// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * NCII appeals (ADR 0019 answer 4, W0 contract step B.9): the owner of content an NCII request
 * removed or auto-hid appeals the request item. Nobody else can (NOT_FOUND, indistinguishable
 * from a missing item); an item that restricted nothing cannot be appealed; one open appeal per
 * item; overturning records the decision only, and the request's decider cannot resolve it.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface AppealDto {
  id: string;
  status: string;
  kind: string;
  subjectType: string;
  subjectId: string;
}

let api: TestApi;
let owner: User;
let other: User;
let clipper: User;
let mod: User;
let mod2: User;
let channelId: string;
let broadcastId: string;
const BODY = "This was my own content and I consented to it being streamed.";

const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  [owner, other, clipper, mod, mod2] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  for (const m of [mod, mod2])
    await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, m.userId));
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, owner.userId));
  channelId = c!.id;
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ channelId, ingestProtocol: "rtmp", path: `live/${uuidv7()}`, startedAt: new Date(Date.now() - 600_000) })
    .returning({ id: schema.broadcasts.id });
  broadcastId = b!.id;
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const appeal = (who: User, subjectId: string, subjectType = "ncii_request_item", kind = "moderation") =>
  who.client.call<AppealDto>("POST", "/api/appeals", { kind, subjectType, subjectId, body: BODY });

const resolve = (who: User, id: string, status: "upheld" | "overturned") =>
  who.client.call<AppealDto>("POST", `/api/admin/appeals/${id}`, { status, resolution: "Reviewed." });

/** A decided (`removed`) request with one item; `restricted: false` leaves it neither removed nor hidden. */
async function nciiItem(
  subjectType: "broadcast" | "vod" | "clip" | "upload",
  subjectId: string,
  opts: { restricted?: boolean; hidden?: boolean; decidedById?: string } = {},
): Promise<string> {
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
    .returning({ id: schema.nciiRequests.id });
  const now = new Date();
  if (opts.decidedById)
    await db()
      .update(schema.nciiRequests)
      .set({ status: "removed", decidedAt: now, decidedById: opts.decidedById })
      .where(eq(schema.nciiRequests.id, req!.id));
  const restricted = opts.restricted ?? true;
  const [item] = await db()
    .insert(schema.nciiRequestItems)
    .values({
      requestId: req!.id,
      url: "https://example.test/x",
      subjectType,
      subjectId,
      removedAt: restricted && !opts.hidden ? now : null,
      hiddenAt: restricted && opts.hidden ? now : null,
    })
    .returning({ id: schema.nciiRequestItems.id });
  return item!.id;
}

async function vod(): Promise<string> {
  const id = uuidv7();
  await db()
    .insert(schema.vods)
    .values({ id, channelId, broadcastId, title: "v", storagePrefix: `vods/${id}/`, status: "ready" });
  return id;
}

async function clip(creatorId: string): Promise<string> {
  const id = uuidv7();
  await db().insert(schema.clips).values({
    id,
    channelId,
    broadcastId,
    creatorId,
    title: "c",
    startOffset: 0,
    durationSeconds: 10,
    status: "ready",
  });
  return id;
}

describe("ncii_request_item appeals", () => {
  test("the channel owner appeals a removed broadcast, VOD, clip or upload item", async () => {
    const items = [
      await nciiItem("broadcast", broadcastId),
      await nciiItem("vod", await vod(), { hidden: true }),
      await nciiItem("clip", await clip(clipper.userId)),
      await nciiItem("upload", channelId),
    ];
    for (const id of items) {
      const res = await appeal(owner, id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ kind: "moderation", subjectType: "ncii_request_item", subjectId: id });
    }
  });

  test("a clip's creator may appeal it too; anyone else gets NOT_FOUND", async () => {
    const clipItem = await nciiItem("clip", await clip(clipper.userId));
    expect((await appeal(other, clipItem)).status).toBe(404);
    expect((await appeal(clipper, clipItem)).status).toBe(200);
  });

  test("someone else's item, a missing item and an item that restricted nothing look the same", async () => {
    const vodItem = await nciiItem("vod", await vod());
    const uploadItem = await nciiItem("upload", channelId);
    const untouched = await nciiItem("broadcast", broadcastId, { restricted: false });
    for (const [who, id] of [
      [other, vodItem],
      [other, uploadItem],
      [owner, uuidv7()],
      [owner, untouched],
    ] as const) {
      const res = await appeal(who, id);
      expect(res.status, id).toBe(404);
    }
  });

  test("only a moderation appeal can name an item", async () => {
    const id = await nciiItem("vod", await vod());
    expect((await appeal(owner, id, "ncii_request_item", "account")).status).toBe(400);
    expect((await appeal(owner, id, "ncii_request_item", "integrity")).status).toBe(400);
  });

  test("one open appeal per item; a new one after it is resolved", async () => {
    const id = await nciiItem("vod", await vod());
    const first = await appeal(owner, id);
    expect(first.status).toBe(200);
    expect((await appeal(owner, id)).status).toBe(409);
    expect((await resolve(mod, first.body.id, "upheld")).status).toBe(200);
    expect((await appeal(owner, id)).status).toBe(200);
  });

  test("overturning records the decision only; the request's decider cannot resolve it", async () => {
    const vodId = await vod();
    const id = await nciiItem("vod", vodId, { decidedById: mod.userId });
    const a = await appeal(owner, id);
    expect(a.status).toBe(200);
    expect((await resolve(mod, a.body.id, "overturned")).status).toBe(403);
    const res = await resolve(mod2, a.body.id, "overturned");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("overturned");
    // Nothing restored: the item and the VOD are as the NCII flow left them.
    const [item] = await db().select().from(schema.nciiRequestItems).where(eq(schema.nciiRequestItems.id, id));
    expect(item?.removedAt).not.toBeNull();
    const audits = await db().select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, a.body.id));
    expect(audits.map((r) => r.action)).toEqual(["appeal.resolve"]);
    expect(audits[0]?.details).toMatchObject({ appealSubjectType: "ncii_request_item", status: "overturned" });
  });
});
