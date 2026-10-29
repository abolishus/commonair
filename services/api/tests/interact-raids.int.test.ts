// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.raids.*` against real Postgres and Valkey (ADR 0026 decision 4; docs/testing/
 * e8-selectors.md "Raids"): every start refusal with its requirement code, the pending raid's
 * `CONFLICT` under concurrency, cancel, current and the policy, and the `raid` control frame on the
 * source's chat control.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { ChatControlMessage } from "@commonair/contracts/chat";
import { RAID_RULES } from "@commonair/contracts/enums";
import { BUS } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { signUpAndSignIn, startApi, subscriber, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>> & { channelId: string };
let src: User;
let dst: User;
let third: User;
const frames: ChatControlMessage[] = [];
const sub = subscriber();

const db = () => api.db.db;

async function withChannel(u: Awaited<ReturnType<typeof signUpAndSignIn>>): Promise<User> {
  const [c] = await db()
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.slug, u.username));
  if (!c) throw new Error("no channel");
  return { ...u, channelId: c.id };
}

async function setLive(u: User, live: boolean) {
  let liveBroadcastId: string | null = null;
  if (live) {
    const [b] = await db()
      .insert(schema.broadcasts)
      .values({ channelId: u.channelId, ingestProtocol: "rtmp", path: `live/${uuidv7()}` })
      .returning({ id: schema.broadcasts.id });
    liveBroadcastId = b?.id ?? null;
  }
  await db().update(schema.channels).set({ liveBroadcastId }).where(eq(schema.channels.id, u.channelId));
}

const setChannel = (u: User, set: Partial<typeof schema.channels.$inferInsert>) =>
  db().update(schema.channels).set(set).where(eq(schema.channels.id, u.channelId));

type Err = { code: string; message: string; data?: { requirement?: string } };
type RaidView = {
  id: string;
  from: string;
  to: string;
  toDisplayName: string;
  viewerCount: number;
  status: string;
  cancelReason: string | null;
  createdAt: string;
  executeAt: string;
};
type RaidState = { raid: RaidView | null; cooldownEndsAt: string | null; policy: string };

const start = (from: User, to: string) =>
  from.client.call<RaidView & Err>("POST", `/api/channels/${from.username}/raids`, { to });
const cancel = (from: User) => from.client.call<Err>("DELETE", `/api/channels/${from.username}/raids`);
const current = (u: User) => u.client.call<RaidState>("GET", `/api/channels/${u.username}/raids`);
const setPolicy = (u: User, policy: string) =>
  u.client.call<RaidState>("PUT", `/api/channels/${u.username}/raids/policy`, { policy });

beforeAll(async () => {
  api = await startApi();
  [src, dst, third] = (await Promise.all([0, 1, 2].map(async () => withChannel(await signUpAndSignIn(api))))) as [
    User,
    User,
    User,
  ];
  sub.on("message", (_c: string, m: string) => frames.push(ChatControlMessage.parse(JSON.parse(m))));
  await sub.subscribe(BUS.chatControl(src.channelId));
}, 120_000);
afterAll(async () => {
  await sub.quit();
  await api?.stop();
});

beforeEach(async () => {
  // Every case starts from no raids, both live, nobody suspended, policy `anyone`.
  await db().delete(schema.raids);
  await db().delete(schema.follows);
  for (const u of [src, dst, third]) {
    await setLive(u, true);
    await setChannel(u, { suspendedAt: null, raidPolicy: "anyone" });
  }
  frames.length = 0;
});

async function expectRefused(r: { status: number; body: Err }, requirement: string) {
  expect(r.status).toBe(412);
  expect(r.body.code).toBe("PRECONDITION_FAILED");
  expect(r.body.data).toEqual({ requirement });
  expect(await db().select().from(schema.raids)).toHaveLength(0);
}

describe("start refusals", () => {
  test("raiding yourself → BAD_REQUEST", async () => {
    const r = await start(src, src.username);
    expect(r.status).toBe(400);
  });
  test("an unknown target → NOT_FOUND", async () => {
    expect((await start(src, "nobodyherexyz")).status).toBe(404);
  });
  test("the source offline → raid_source_offline", async () => {
    await setLive(src, false);
    await expectRefused(await start(src, dst.username), "raid_source_offline");
  });
  test("the target offline → raid_target_offline", async () => {
    await setLive(dst, false);
    await expectRefused(await start(src, dst.username), "raid_target_offline");
  });
  test("either side suspended → raid_suspended", async () => {
    await setChannel(dst, { suspendedAt: new Date() });
    await expectRefused(await start(src, dst.username), "raid_suspended");
    await setChannel(dst, { suspendedAt: null });
    await setChannel(src, { suspendedAt: new Date() });
    await expectRefused(await start(src, dst.username), "raid_suspended");
  });
  test("policy off → raid_refused", async () => {
    await setPolicy(dst, "off");
    await expectRefused(await start(src, dst.username), "raid_refused");
  });
  test("policy followed: refused without the follow, accepted with it; an excluded follow does not count", async () => {
    await setPolicy(dst, "followed");
    await expectRefused(await start(src, dst.username), "raid_refused");
    // The source owner following the target is the wrong direction.
    await db().insert(schema.follows).values({ followerId: src.userId, channelId: dst.channelId });
    await expectRefused(await start(src, dst.username), "raid_refused");
    await db()
      .insert(schema.follows)
      .values({ followerId: dst.userId, channelId: src.channelId, excludedAt: new Date() });
    await expectRefused(await start(src, dst.username), "raid_refused");
    await db()
      .update(schema.follows)
      .set({ excludedAt: null })
      .where(and(eq(schema.follows.followerId, dst.userId), eq(schema.follows.channelId, src.channelId)));
    expect((await start(src, dst.username)).status).toBe(200);
  });
  test("cooldown: refused one second inside, allowed one second past the boundary", async () => {
    const cd = RAID_RULES.cooldownSeconds * 1000;
    const [old] = await db()
      .insert(schema.raids)
      .values({
        fromChannelId: src.channelId,
        toChannelId: third.channelId,
        status: "completed",
        executeAt: new Date(Date.now() - cd),
        executedAt: new Date(Date.now() - cd + 5_000),
      })
      .returning();
    const r = await start(src, dst.username);
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "raid_cooldown" });
    expect(r.body.message).toMatch(/\d+ seconds/);
    const state = await current(src);
    expect(state.body.cooldownEndsAt).not.toBeNull();

    await db()
      .update(schema.raids)
      .set({ executedAt: new Date(Date.now() - cd - 1_000) })
      .where(eq(schema.raids.id, old!.id));
    expect((await start(src, dst.username)).status).toBe(200);
  });
  test("a canceled raid starts the cooldown too", async () => {
    await db().insert(schema.raids).values({
      fromChannelId: src.channelId,
      toChannelId: third.channelId,
      status: "canceled",
      cancelReason: "owner",
      executeAt: new Date(),
      canceledAt: new Date(),
    });
    const r = await start(src, dst.username);
    expect(r.body.data).toEqual({ requirement: "raid_cooldown" });
  });
  test("a non-owner cannot start a raid for the channel", async () => {
    const r = await dst.client.call("POST", `/api/channels/${src.username}/raids`, { to: third.username });
    expect(r.status).toBe(403);
  });
});

describe("start, pending and cancel", () => {
  test("start → pending raid, audit, and the pending frame in the source room", async () => {
    const before = Date.now();
    const r = await start(src, dst.username);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      from: src.username,
      to: dst.username,
      toDisplayName: expect.any(String),
      viewerCount: 0,
      status: "pending",
      cancelReason: null,
    });
    const countdown = Date.parse(r.body.executeAt) - Date.parse(r.body.createdAt);
    expect(countdown).toBe(RAID_RULES.countdownSeconds * 1000);
    expect(Date.parse(r.body.createdAt)).toBeGreaterThanOrEqual(before - 1000);

    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "raid.start"), eq(schema.auditLog.subjectId, r.body.id)));
    expect(a).toMatchObject({ actorId: src.userId, channelId: src.channelId, details: { toChannelId: dst.channelId } });

    const f = await waitFor(async () => frames.find((x) => x.op === "raid" && x.raidId === r.body.id));
    expect(f).toEqual({
      op: "raid",
      channel: src.username,
      raidId: r.body.id,
      status: "pending",
      to: dst.username,
      toDisplayName: r.body.toDisplayName,
      executeAt: r.body.executeAt,
    });

    const st = await current(src);
    expect(st.body).toEqual({ raid: r.body, cooldownEndsAt: null, policy: "anyone" });
  });

  test("a second start while one is pending → CONFLICT with no requirement", async () => {
    expect((await start(src, dst.username)).status).toBe(200);
    const r = await start(src, third.username);
    expect(r.status).toBe(409);
    expect(r.body.data?.requirement).toBeUndefined();
  });

  test("two concurrent starts: exactly one raid", async () => {
    const rs = await Promise.all([start(src, dst.username), start(src, third.username), start(src, dst.username)]);
    expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409, 409]);
    const rows = await db().select().from(schema.raids).where(eq(schema.raids.fromChannelId, src.channelId));
    expect(rows).toHaveLength(1);
  });

  test("cancel → canceled by owner, audit, frame; then the cooldown runs; cancel again → NOT_FOUND", async () => {
    const r = await start(src, dst.username);
    const c = await cancel(src);
    expect(c.status).toBe(200);
    expect(c.body).toEqual({ ok: true });
    const [row] = await db().select().from(schema.raids).where(eq(schema.raids.id, r.body.id));
    expect(row).toMatchObject({ status: "canceled", cancelReason: "owner" });
    expect(row?.canceledAt).toBeInstanceOf(Date);
    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "raid.cancel"), eq(schema.auditLog.subjectId, r.body.id)));
    expect(a?.details).toEqual({ reason: "owner" });
    await waitFor(async () => frames.find((x) => x.op === "raid" && x.raidId === r.body.id && x.status === "canceled"));

    const st = await current(src);
    expect(st.body.raid).toMatchObject({ id: r.body.id, status: "canceled", cancelReason: "owner" });
    expect(Date.parse(st.body.cooldownEndsAt ?? "")).toBeGreaterThan(Date.now());

    expect((await cancel(src)).status).toBe(404);
  });

  test("current with no raid at all", async () => {
    expect((await current(third)).body).toEqual({ raid: null, cooldownEndsAt: null, policy: "anyone" });
  });
});

describe("policy", () => {
  test("setPolicy updates the channel, audits and returns the state", async () => {
    const r = await setPolicy(third, "followed");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ raid: null, cooldownEndsAt: null, policy: "followed" });
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.id, third.channelId));
    expect(c?.raidPolicy).toBe("followed");
    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "raid.policy"), eq(schema.auditLog.subjectId, third.channelId)));
    expect(a?.details).toEqual({ policy: "followed" });
    expect((await current(third)).body.policy).toBe("followed");
  });
  test("an unknown policy is a validation error", async () => {
    expect((await setPolicy(third, "friends")).status).toBe(400);
  });
});
