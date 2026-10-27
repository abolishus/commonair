// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `safety.dmca.*` end to end against Postgres (17 U.S.C. § 512; not reviewed by a lawyer):
 * submit (ALTCHA, URL resolution), the queue, action (reversible removal hidden from owner and
 * public, one strike per owner per notice, the repeat-infringer suspension), reject, the
 * counter-notice and its validation, suit filed, `mine`, the `dmca-tick` hook, and that no
 * claimant or counter-notice detail reaches an audit row or an event.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, MODERATION_JOBS } from "@commonair/contracts/internal";
import { reconcileDmcaTerminationInTx, reverseAccountActionInTx, schema, uuidv7 } from "@commonair/db";
import { restoreAfter } from "../src/dmca/rules.ts";
import { startModeration } from "../src/moderation/index.ts";
import { recordingQueue } from "../src/moderation/queue.ts";
import { setSuspension } from "../src/moderation/suspension.ts";
import {
  client,
  mailTo,
  signUpAndSignIn,
  solveAltcha,
  startApi,
  uniqueName,
  waitFor,
  type TestApi,
} from "./harness.ts";

type Signed = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Item = {
  id: string;
  subjectType: string | null;
  subjectId: string | null;
  ownerId: string | null;
  removedAt: string | null;
  restoredAt: string | null;
  url: string;
};
type Notice = {
  id: string;
  status: string;
  items: Item[];
  counters: { id: string; suitFiledAt: string | null; restoreAfter: string }[];
  ownerStrikes: Record<string, number>;
  claimantEmail?: string;
};

let api: TestApi;
let off: TestApi;
const queue = recordingQueue(undefined, { restored: 2, counters: 1 });
let mod: Signed;
let mod2: Signed;

beforeAll(async () => {
  [api, off] = await Promise.all([
    startApi({ env: { MODERATION_TEST_HOOKS: "true", MODERATION_CLASSIFIER: "scripted" } }),
    startApi(),
  ]);
  // Before anything else touches the runtime: the action handler enqueues on this queue.
  await startModeration(api.deps, { queue });
  [mod, mod2] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db()
    .update(schema.users)
    .set({ role: "moderator" })
    .where(inArray(schema.users.id, [mod.userId, mod2.userId]));
}, 120_000);
afterAll(async () => {
  await Promise.all([api?.stop(), off?.stop()]);
});

const db = () => api.db.db;

async function channelOf(userId: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, userId));
  if (!c) throw new Error("no channel");
  return c;
}

async function broadcast(channelId: string, live = false) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      startedAt: new Date(Date.now() - 600_000),
      endedAt: live ? null : new Date(),
    })
    .returning();
  if (!b) throw new Error("no broadcast");
  if (live) await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, channelId));
  return b;
}

async function vod(channelId: string, broadcastId: string, v: Partial<typeof schema.vods.$inferInsert> = {}) {
  const id = uuidv7();
  await db()
    .insert(schema.vods)
    .values({ id, channelId, broadcastId, title: "a vod", storagePrefix: `vods/${id}/`, status: "ready", ...v });
  return id;
}

async function clip(channelId: string, broadcastId: string, c: Partial<typeof schema.clips.$inferInsert> = {}) {
  const id = uuidv7();
  await db()
    .insert(schema.clips)
    .values({
      id,
      channelId,
      broadcastId,
      title: "a clip",
      startOffset: 0,
      durationSeconds: 5,
      status: "ready",
      storageKey: `clips/${id}.mp4`,
      ...c,
    });
  return id;
}

/** Content owned by a fresh streamer: a VOD, a clip of it, a separate clip. */
async function streamer() {
  const s = await signUpAndSignIn(api);
  const c = await channelOf(s.userId);
  const b = await broadcast(c.id);
  const v = await vod(c.id, b.id);
  const clipOfVod = await clip(c.id, b.id, { vodId: v });
  const other = await broadcast(c.id);
  const lone = await clip(c.id, other.id);
  return { s, c, b, vod: v, clipOfVod, lone };
}

const vodUrl = (slug: string, id: string) => `${api.url}/${slug}/videos/${id}`;
const clipUrl = (slug: string, id: string) => `${api.url}/${slug}/clip/${id}`;

let seq = 0;
function claimant() {
  seq++;
  return {
    claimantName: `Claire Claimant ${seq} ${uniqueName("n")}`,
    claimantEmail: `${uniqueName("claimant")}@test.invalid`,
    claimantAddress: `${seq} Rights Road ${uniqueName("a")}`,
    claimantPhone: `+1 555 01${String(seq).padStart(2, "0")}`,
    copyrightedWork: `The song ${uniqueName("w")}`,
    signature: `Claire Signature ${uniqueName("s")}`,
  };
}
const secretsSeen: string[] = [];

async function submit(urls: string[], who = claimant()) {
  secretsSeen.push(who.claimantName, who.claimantEmail, who.claimantAddress, who.claimantPhone, who.signature);
  const r = await client(api).call<{ id: string }>("POST", "/api/dmca/notices", {
    ...who,
    infringingUrls: urls,
    goodFaithStatement: true,
    accuracyStatement: true,
    altcha: await solveAltcha(api),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { id: r.body.id, who };
}

async function notice(id: string): Promise<Notice> {
  for (const status of ["received", "actioned", "rejected", "countered", "restored"]) {
    let cursor: string | null = null;
    do {
      const q: string = `/api/admin/dmca?status=${status}&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
      const r = await mod.client.call<{ items: Notice[]; nextCursor: string | null }>("GET", q);
      expect(r.status).toBe(200);
      const hit = r.body.items.find((n) => n.id === id);
      if (hit) return hit;
      cursor = r.body.nextCursor;
    } while (cursor);
  }
  throw new Error(`notice ${id} not in the queue`);
}

const action = (id: string, decision: "actioned" | "rejected", note = "harness note", who = mod) =>
  who.client.call<Notice>("POST", `/api/admin/dmca/${id}`, { decision, note });

async function strikes(userId: string) {
  return db()
    .select()
    .from(schema.accountActions)
    .where(and(eq(schema.accountActions.userId, userId), eq(schema.accountActions.action, "dmca_strike")));
}

describe("submit", () => {
  test("a refused ALTCHA is a 400 and stores nothing", async () => {
    const r = await client(api).call("POST", "/api/dmca/notices", {
      ...claimant(),
      infringingUrls: ["https://elsewhere.example/x"],
      goodFaithStatement: true,
      accuracyStatement: true,
      altcha: "not-a-solution",
    });
    expect(r.status).toBe(400);
  });

  test("URLs are de-duplicated and resolved; unknown ones stay unresolved; the owner is the channel owner", async () => {
    const o = await streamer();
    const url = clipUrl(o.c.slug, o.lone);
    const { id } = await submit([url, `${url}/`, `${url}#t=3`, "https://elsewhere.example/watch?v=1"]);
    const items = await db().select().from(schema.dmcaNoticeItems).where(eq(schema.dmcaNoticeItems.noticeId, id));
    expect(items).toHaveLength(2);
    const resolved = items.find((i) => i.subjectType === "clip");
    expect(resolved).toMatchObject({ subjectId: o.lone, ownerId: o.s.userId, channelId: o.c.id, removedAt: null });
    expect(items.find((i) => i.subjectType === null)).toMatchObject({ subjectId: null, ownerId: null });
    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, "dmca.notice.submit")));
    expect(a).toMatchObject({ actorType: "system", details: { noticeId: id, items: 2, resolvedItems: 1 } });
    const events = await db().select().from(schema.events).where(eq(schema.events.type, "dmca.notice.received"));
    expect(events.find((e) => (e.payload as { notice_id?: string }).notice_id === id)?.payload).toEqual({
      notice_id: id,
      items: 2,
      resolved_items: 1,
    });
    // The owner hears nothing until a moderator actions it.
    expect((await o.s.client.call<unknown[]>("GET", "/api/dmca/mine")).body).toEqual([]);
  });
});

describe("queue", () => {
  test("received notices page oldest first with a keyset cursor; staff only", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await submit(["https://elsewhere.example/q"])).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { status: number; body: { items: Notice[]; nextCursor: string | null } } = await mod.client.call(
        "GET",
        `/api/admin/dmca?status=received&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.items.map((n) => n.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    const order = seen.filter((x) => ids.includes(x));
    expect(order).toEqual(ids);
    const user = await signUpAndSignIn(api);
    expect((await user.client.call("GET", "/api/admin/dmca")).status).toBe(403);
  });
});

describe("action", () => {
  test("actioned: the VOD, its clips and the clip are hidden from owner and public, one strike, owner told", async () => {
    const o = await streamer();
    const { id, who } = await submit([
      vodUrl(o.c.slug, o.vod),
      clipUrl(o.c.slug, o.lone),
      "https://elsewhere.example/z",
    ]);
    const r = await action(id, "actioned");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe("actioned");
    expect(r.body.items.filter((i) => i.removedAt !== null)).toHaveLength(2);
    expect(r.body.ownerStrikes).toEqual({ [o.s.userId]: 1 });

    const [v] = await db().select().from(schema.vods).where(eq(schema.vods.id, o.vod));
    expect(v).toMatchObject({ status: "ready", removedReason: "dmca" });
    for (const [kind, sid] of [
      ["vods", o.vod],
      ["clips", o.lone],
      ["clips", o.clipOfVod],
    ] as const) {
      expect((await o.s.client.call("GET", `/api/${kind}/${sid}`)).status, `${kind} owner`).toBe(404);
      expect((await client(api).call("GET", `/api/${kind}/${sid}`)).status, `${kind} public`).toBe(404);
    }
    const listed = await o.s.client.call<{ items: { id: string }[] }>("GET", `/api/channels/${o.c.slug}/clips`);
    expect(listed.body.items.map((i) => i.id)).not.toContain(o.clipOfVod);

    expect(await strikes(o.s.userId)).toHaveLength(1);
    expect(queue.jobs).toContainEqual(
      expect.objectContaining({ name: MODERATION_JOBS.dmcaDisable, data: { noticeId: id } }),
    );
    const mail = await waitFor(() => mailTo(o.s.email));
    expect(mail.subject).toContain("Copyright notice about");
    const claim = await waitFor(() => mailTo(who.claimantEmail));
    expect(claim.subject).toContain("was actioned");

    // The owner sees the notice: their items, the claimant's name, never the contact details.
    const mine = await o.s.client.call<Record<string, unknown>[]>("GET", "/api/dmca/mine");
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ id, status: "actioned", claimantName: who.claimantName, counter: null });
    const text = JSON.stringify(mine.body);
    for (const x of [who.claimantEmail, who.claimantAddress, who.claimantPhone, who.signature])
      expect(text).not.toContain(x);
    expect(((mine.body[0]?.items ?? []) as Item[]).every((i) => i.ownerId === o.s.userId)).toBe(true);

    // Deciding again is a conflict.
    expect((await action(id, "rejected")).status).toBe(409);
    expect((await action(id, "actioned")).status).toBe(409);
  });

  test("a moderator cannot decide a notice about their own content", async () => {
    const c = await channelOf(mod2.userId);
    const b = await broadcast(c.id);
    const cl = await clip(c.id, b.id);
    const { id } = await submit([clipUrl(c.slug, cl)]);
    expect((await action(id, "actioned", "x", mod2)).status).toBe(403);
  });

  test("a live broadcast item ends the stream and hides its recordings", async () => {
    const s = await signUpAndSignIn(api);
    const c = await channelOf(s.userId);
    const b = await broadcast(c.id, true);
    const v = await vod(c.id, b.id, { status: "recording" });
    const { id } = await submit([`${api.url}/${c.slug}`]);
    const before = await notice(id);
    expect(before.items[0]).toMatchObject({ subjectType: "broadcast", subjectId: b.id });
    expect((await action(id, "actioned")).status).toBe(200);
    const [bb] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b.id));
    expect(bb?.endedAt).not.toBeNull();
    const [vv] = await db().select().from(schema.vods).where(eq(schema.vods.id, v));
    expect(vv?.removedReason).toBe("dmca");
  });

  test("rejected: nothing is hidden, no strike, the claimant hears the note", async () => {
    const o = await streamer();
    const { id, who } = await submit([clipUrl(o.c.slug, o.lone)]);
    const r = await action(id, "rejected", "The notice does not identify the copyrighted work.");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("rejected");
    const [c] = await db().select().from(schema.clips).where(eq(schema.clips.id, o.lone));
    expect(c?.removedReason).toBeNull();
    expect(await strikes(o.s.userId)).toHaveLength(0);
    const mail = await waitFor(() => mailTo(who.claimantEmail));
    expect(mail.subject).toContain("could not be actioned");
    expect(mail.text).toContain("does not identify the copyrighted work");
    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, "dmca.notice.reject")));
    expect(a?.reason).toBe("");
    const [n] = await db().select().from(schema.dmcaNotices).where(eq(schema.dmcaNotices.id, id));
    expect(n?.decisionNote).toBe("The notice does not identify the copyrighted work.");
  });

  test("two owners in one notice: one strike each, never one per URL", async () => {
    const a = await streamer();
    const b = await streamer();
    const { id } = await submit([clipUrl(a.c.slug, a.lone), vodUrl(a.c.slug, a.vod), clipUrl(b.c.slug, b.lone)]);
    expect((await action(id, "actioned")).status).toBe(200);
    expect(await strikes(a.s.userId)).toHaveLength(1);
    expect(await strikes(b.s.userId)).toHaveLength(1);
  });
});

describe("repeat infringers", () => {
  test("the third unreversed strike suspends the account (dmca_repeat_infringer) and notifies moderators", async () => {
    const o = await streamer();
    for (const target of [clipUrl(o.c.slug, o.lone), clipUrl(o.c.slug, o.clipOfVod), vodUrl(o.c.slug, o.vod)]) {
      const { id } = await submit([target]);
      expect((await action(id, "actioned")).status).toBe(200);
    }
    const terms = await db()
      .select()
      .from(schema.accountActions)
      .where(and(eq(schema.accountActions.userId, o.s.userId), eq(schema.accountActions.action, "dmca_termination")));
    expect(terms).toHaveLength(1);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, o.s.userId));
    expect(u).toMatchObject({ banned: true, banReason: "dmca_repeat_infringer" });
    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, o.s.userId), eq(schema.auditLog.action, "account.dmca_termination")));
    expect(a?.details).toMatchObject({ strikes: 3, suspended: true });
    const notes = await db().select().from(schema.notifications).where(eq(schema.notifications.userId, mod.userId));
    expect(notes.some((n) => (n.payload as { kind?: string }).kind === "dmca_repeat_infringer")).toBe(true);
  });

  test("a moderation suspension is kept, and survives the termination's reversal", async () => {
    const o = await streamer();
    await db().transaction((tx) =>
      setSuspension(tx, { userId: o.s.userId, channelId: o.c.id }, "user", true, new Date(), undefined, "moderation"),
    );
    const noticeIds: string[] = [];
    for (const target of [clipUrl(o.c.slug, o.lone), clipUrl(o.c.slug, o.clipOfVod), vodUrl(o.c.slug, o.vod)]) {
      const { id } = await submit([target]);
      noticeIds.push(id);
      expect((await action(id, "actioned")).status).toBe(200);
    }
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, o.s.userId));
    expect(u).toMatchObject({ banned: true, banReason: "moderation" });
    const [term] = await db()
      .select()
      .from(schema.accountActions)
      .where(and(eq(schema.accountActions.userId, o.s.userId), eq(schema.accountActions.action, "dmca_termination")));
    expect(term?.reversedAt).toBeNull();
    // What a restore does: reverse one strike, then reconcile the termination.
    const [one] = await strikes(o.s.userId);
    const reversed = await db().transaction(async (tx) => {
      await reverseAccountActionInTx(tx, {
        id: one!.id,
        now: new Date(),
        byId: null,
        reason: "counter_notice_restored",
      });
      return reconcileDmcaTerminationInTx(tx, { userId: o.s.userId, now: new Date(), byId: null });
    });
    expect(reversed?.id).toBe(term?.id);
    const [after] = await db().select().from(schema.users).where(eq(schema.users.id, o.s.userId));
    expect(after).toMatchObject({ banned: true, banReason: "moderation" });
  });
});

describe("counter-notice", () => {
  const counterBody = (itemIds: string[]) => ({
    fullName: `Ada Uploader ${uniqueName("f")}`,
    address: `2 Uploader Lane ${uniqueName("a")}`,
    phone: "+1 555 0200",
    itemIds,
    statement: `Removed by mistake ${uniqueName("st")}`,
    goodFaithStatement: true,
    consentToJurisdiction: true,
    signature: "Ada Uploader",
  });

  test("validation: only your own removed, unrestored items; once per notice; only after action", async () => {
    const a = await streamer();
    const b = await streamer();
    const { id } = await submit([clipUrl(a.c.slug, a.lone), clipUrl(b.c.slug, b.lone), vodUrl(a.c.slug, a.vod)]);
    // Before the decision there is nothing to counter.
    const pending = await notice(id);
    const aItem = pending.items.find((i) => i.subjectId === a.lone)!;
    const bItem = pending.items.find((i) => i.subjectId === b.lone)!;
    expect((await a.s.client.call("POST", `/api/dmca/notices/${id}/counter`, counterBody([aItem.id]))).status).toBe(
      409,
    );
    expect((await action(id, "actioned")).status).toBe(200);
    // Someone else's item.
    expect((await a.s.client.call("POST", `/api/dmca/notices/${id}/counter`, counterBody([bItem.id]))).status).toBe(
      400,
    );
    // An item that is not part of the notice.
    expect((await a.s.client.call("POST", `/api/dmca/notices/${id}/counter`, counterBody([uuidv7()]))).status).toBe(
      400,
    );
    // A user with nothing in the notice does not see it.
    const stranger = await signUpAndSignIn(api);
    expect(
      (await stranger.client.call("POST", `/api/dmca/notices/${id}/counter`, counterBody([aItem.id]))).status,
    ).toBe(404);

    const body = counterBody([aItem.id]);
    secretsSeen.push(body.fullName, body.address, body.statement);
    const before = Date.now();
    const ok = await a.s.client.call<{ restoreAfter: string }>("POST", `/api/dmca/notices/${id}/counter`, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const expected = restoreAfter(new Date(before)).getTime();
    expect(Math.abs(new Date(ok.body.restoreAfter).getTime() - expected)).toBeLessThan(60_000);
    expect((await a.s.client.call("POST", `/api/dmca/notices/${id}/counter`, body)).status).toBe(409);
    const n = await notice(id);
    expect(n.status).toBe("countered");
    expect(n.counters).toHaveLength(1);
    const claimEmail = n.claimantEmail ?? "";
    const forwarded = await waitFor(async () => {
      const m = await mailTo(claimEmail);
      return m?.subject.includes("Counter-notice") ? m : null;
    });
    for (const part of [body.fullName, body.address, body.phone, body.statement])
      expect(forwarded.text).toContain(part);
    // The owner's view shows the receipt.
    const mine = await a.s.client.call<{ id: string; counter: { restoreAfter: string } | null }[]>(
      "GET",
      "/api/dmca/mine",
    );
    expect(mine.body.find((x) => x.id === id)?.counter?.restoreAfter).toBe(ok.body.restoreAfter);
  });

  test("an unremoved item (content already gone at action time) cannot be countered", async () => {
    const a = await streamer();
    const { id } = await submit([clipUrl(a.c.slug, a.lone), vodUrl(a.c.slug, a.vod)]);
    // The owner deletes the VOD before the moderator acts.
    await db().update(schema.vods).set({ status: "deleted", removedReason: "owner" }).where(eq(schema.vods.id, a.vod));
    expect((await action(id, "actioned")).status).toBe(200);
    const n = await notice(id);
    const vItem = n.items.find((i) => i.subjectId === a.vod)!;
    expect(vItem.removedAt).toBeNull();
    const r = await a.s.client.call("POST", `/api/dmca/notices/${id}/counter`, counterBody([vItem.id]));
    expect(r.status).toBe(400);
  });

  test("suit filed: recorded once, blocks a second record, staff only", async () => {
    const a = await streamer();
    const { id } = await submit([clipUrl(a.c.slug, a.lone)]);
    expect((await action(id, "actioned")).status).toBe(200);
    const item = (await notice(id)).items[0]!;
    expect((await a.s.client.call("POST", `/api/dmca/notices/${id}/counter`, counterBody([item.id]))).status).toBe(200);
    const counterId = (await notice(id)).counters[0]!.id;
    expect(
      (await a.s.client.call("POST", `/api/admin/dmca/counter-notices/${counterId}/suit`, { note: "x" })).status,
    ).toBe(403);
    const r = await mod.client.call<Notice>("POST", `/api/admin/dmca/counter-notices/${counterId}/suit`, {
      note: "Claimant's lawyer sent the docket number",
    });
    expect(r.status).toBe(200);
    expect(r.body.counters[0]?.suitFiledAt).not.toBeNull();
    expect(
      (await mod.client.call("POST", `/api/admin/dmca/counter-notices/${counterId}/suit`, { note: "again" })).status,
    ).toBe(409);
    const [a2] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, "dmca.counter.suit_filed")));
    expect(a2?.details).toEqual({ noticeId: id, counterNoticeId: counterId });
    expect(a2?.reason).toBe("");
  });
});

describe("dmca-tick test hook", () => {
  const call = (t: TestApi, body: unknown, secret = t.internalSecret) =>
    fetch(`${t.url}${INTERNAL_ROUTES.dmcaTick}`, {
      method: "POST",
      headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
      body: JSON.stringify(body),
    });

  test("404 without MODERATION_TEST_HOOKS, even with the secret", async () => {
    expect((await call(off, { asOf: new Date().toISOString() })).status).toBe(404);
  });

  test("with hooks: secret required, body validated, runs the restore as of the given time", async () => {
    expect((await call(api, { asOf: new Date().toISOString() }, "wrong")).status).toBe(401);
    expect((await call(api, { asOf: "tomorrow" })).status).toBe(400);
    const asOf = "2026-11-20T12:00:00.000Z";
    const r = await call(api, { asOf });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ restored: 2, counters: 1 });
    expect(queue.restoreCalls).toContain(asOf);
  });
});

describe("records", () => {
  test("every DMCA audit row and event carries ids, enums and counts only", async () => {
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.subjectType, ["dmca_notice", "user"]));
    const events = await db().select().from(schema.events);
    const dmcaEvents = events.filter((e) => e.type.startsWith("dmca.") || e.type.startsWith("account.action."));
    expect(audits.filter((a) => a.action.startsWith("dmca.")).length).toBeGreaterThan(5);
    expect(dmcaEvents.length).toBeGreaterThan(5);
    const blob = JSON.stringify([audits.map((a) => [a.details, a.reason]), dmcaEvents.map((e) => e.payload)]);
    expect(secretsSeen.length).toBeGreaterThan(10);
    for (const s of secretsSeen) expect(blob).not.toContain(s);
    const actions = await db().select().from(schema.accountActions);
    expect(JSON.stringify(actions)).not.toMatch(/Claire|Rights Road|Uploader Lane/);
  });

  test("each decision's audit row and event are written together", async () => {
    const o = await streamer();
    const { id } = await submit([clipUrl(o.c.slug, o.lone)]);
    expect((await action(id, "actioned")).status).toBe(200);
    const audits = await db().select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, id));
    expect(audits.map((a) => a.action).sort()).toEqual(["dmca.notice.action", "dmca.notice.submit"]);
    const events = (await db().select().from(schema.events)).filter(
      (e) => (e.payload as { notice_id?: string }).notice_id === id,
    );
    expect(events.map((e) => e.type).sort()).toEqual(["dmca.notice.decided", "dmca.notice.received"]);
    const recorded = (await db().select().from(schema.events)).filter(
      (e) => e.type === "account.action.recorded" && (e.payload as { source_id?: string }).source_id === id,
    );
    expect(recorded).toHaveLength(1);
  });
});
