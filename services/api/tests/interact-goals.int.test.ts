// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.goals.*` and `overlays.state.goals` against real Postgres (ADR 0026 decision 5;
 * docs/testing/e8-selectors.md "Goals"): create with its `begin` event and audit, one open goal per
 * type (also under concurrency), end with `is_achieved`, the public list order.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>> & { channelId: string };
let s: User;
let other: User;
const db = () => api.db.db;

type Goal = {
  id: string;
  type: string;
  title: string;
  target: number;
  current: number;
  startedAt: string;
  endedAt: string | null;
};

beforeAll(async () => {
  api = await startApi();
  [s, other] = (await Promise.all(
    [0, 1].map(async () => {
      const u = await signUpAndSignIn(api);
      const [c] = await api.db.db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.slug, u.username));
      return { ...u, channelId: c!.id };
    }),
  )) as [User, User];
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const create = (u: User, body: Record<string, unknown>) =>
  u.client.call<Goal & { code?: string }>("POST", `/api/channels/${u.username}/goals`, body);
const end = (u: User, id: string, as: User = u) =>
  as.client.call<Goal>("POST", `/api/channels/${u.username}/goals/${id}/end`, {});
const list = (slug: string) => client(api).call<Goal[]>("GET", `/api/channels/${slug}/goals`);

const eventsOf = (channelId: string, type: string) =>
  db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, type)))
    .orderBy(asc(schema.events.occurredAt));

describe("goals", () => {
  test("create → the open goal from 0, a begin event and an audit row", async () => {
    const r = await create(s, { type: "followers", title: "Ten follows", target: 10 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ type: "followers", title: "Ten follows", target: 10, current: 0, endedAt: null });
    const [ev] = await eventsOf(s.channelId, "channel.goal.begin");
    expect(ev?.payload).toMatchObject({
      broadcaster_user_id: s.userId,
      broadcaster_user_login: s.username,
      id: r.body.id,
      type: "followers",
      description: "Ten follows",
      current_amount: 0,
      target_amount: 10,
      started_at: r.body.startedAt,
    });
    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "goal.create"), eq(schema.auditLog.subjectId, r.body.id)));
    // The title is the streamer's free text: never in the append-only audit row.
    expect(a?.details).toEqual({ type: "followers", target: 10 });
  });

  test("a second open goal of a type → CONFLICT; another type is fine", async () => {
    const r = await create(s, { type: "followers", title: "Again", target: 3 });
    expect(r.status).toBe(409);
    const tips = await create(s, { type: "tips", title: "Tips", target: 5000 });
    expect(tips.status).toBe(200);
    expect(tips.body.target).toBe(5000);
  });

  test("two concurrent creates of one type: one goal", async () => {
    const rs = await Promise.all([
      create(other, { type: "subscriptions", title: "A", target: 2 }),
      create(other, { type: "subscriptions", title: "B", target: 2 }),
    ]);
    expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const rows = await db()
      .select()
      .from(schema.goals)
      .where(and(eq(schema.goals.channelId, other.channelId), eq(schema.goals.type, "subscriptions")));
    expect(rows).toHaveLength(1);
  });

  test("input bounds: title ≤ 60, target > 0", async () => {
    expect((await create(other, { type: "tips", title: "x".repeat(61), target: 1 })).status).toBe(400);
    expect((await create(other, { type: "tips", title: "ok", target: 0 })).status).toBe(400);
    expect((await create(other, { type: "tips", title: "", target: 1 })).status).toBe(400);
  });

  test("overlays.state returns the open goals", async () => {
    const tok = await s.client.call<{ token: string }>("POST", `/api/channels/${s.username}/overlay-token`, {});
    const st = await client(api).call<{ goals: Goal[] }>(
      "GET",
      `/api/overlay/state?token=${encodeURIComponent(tok.body.token)}`,
    );
    expect(st.status).toBe(200);
    expect(st.body.goals.map((g) => g.type).sort()).toEqual(["followers", "tips"]);
    expect(st.body.goals.every((g) => g.endedAt === null)).toBe(true);
  });

  test("end → endedAt, an end event with is_achieved, an audit row; ending again is a no-op", async () => {
    const [open] = (await list(s.username)).body.filter((g) => g.type === "followers");
    await db().update(schema.goals).set({ current: 4 }).where(eq(schema.goals.id, open!.id));
    const r = await end(s, open!.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: open!.id, current: 4, endedAt: expect.any(String) });
    const ends = await eventsOf(s.channelId, "channel.goal.end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.payload).toMatchObject({
      id: open!.id,
      is_achieved: false,
      current_amount: 4,
      ended_at: r.body.endedAt,
    });
    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "goal.end"), eq(schema.auditLog.subjectId, open!.id)));
    expect(a?.details).toEqual({ achieved: false });

    const again = await end(s, open!.id);
    expect(again.status).toBe(200);
    expect(again.body.endedAt).toBe(r.body.endedAt);
    expect(await eventsOf(s.channelId, "channel.goal.end")).toHaveLength(1);
  });

  test("an achieved goal ended by the streamer reports is_achieved", async () => {
    const g = await create(s, { type: "followers", title: "One", target: 1 });
    await db().update(schema.goals).set({ current: 1 }).where(eq(schema.goals.id, g.body.id));
    await end(s, g.body.id);
    const ends = await eventsOf(s.channelId, "channel.goal.end");
    expect(ends.find((e) => (e.payload as { id: string }).id === g.body.id)?.payload).toMatchObject({
      is_achieved: true,
    });
  });

  test("end: another channel's goal → NOT_FOUND; a non-owner → FORBIDDEN", async () => {
    const [tips] = (await list(s.username)).body.filter((g) => g.type === "tips" && g.endedAt === null);
    expect((await end(other, tips!.id)).status).toBe(404);
    expect((await end(s, tips!.id, other)).status).toBe(403);
  });

  test("list (public): open goals first, then the ten most recently ended", async () => {
    for (let i = 0; i < 12; i++) {
      const g = await create(other, { type: "followers", title: `G${i}`, target: 5 });
      await end(other, g.body.id);
    }
    const r = await list(other.username);
    expect(r.status).toBe(200);
    const open = r.body.filter((g) => g.endedAt === null);
    expect(open.map((g) => g.type)).toEqual(["subscriptions"]);
    expect(r.body[0]?.endedAt).toBeNull();
    const ended = r.body.slice(1);
    expect(ended).toHaveLength(10);
    expect(ended.map((g) => g.title)).toEqual(["G11", "G10", "G9", "G8", "G7", "G6", "G5", "G4", "G3", "G2"]);
    expect((await list("nosuchchannelxyz")).status).toBe(404);
  });

  test("list (public) of a suspended channel is empty", async () => {
    const ch = eq(schema.channels.id, other.channelId);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(ch);
    try {
      const r = await list(other.username);
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    } finally {
      await db().update(schema.channels).set({ suspendedAt: null }).where(ch);
    }
  });
});
