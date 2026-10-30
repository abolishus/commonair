// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `chat.surge.state` / `chat.surge.override` (ADR 0015 decision 6): moderator only, refused with the
 * instance flag off or the channel's guard disabled, audited with the begin/end outbox event in one
 * transaction, the override key with its TTL, and the `surge` frame on the channel's chat control.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { KEYS } from "@commonair/contracts/internal";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { schema } from "@commonair/db";
import { signUpAndSignIn, startApi, subscriber, waitFor, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
type State = {
  state: string;
  since: string | null;
  until: string | null;
  by: { id: string; username: string } | null;
  unavailable: boolean;
};

let api: TestApi;
let streamer: Person;
let mod: Person;
let viewer: Person;
let channelId: string;
const env = () => api.deps.env as unknown as { CHAT_SURGE_GUARD: "off" | "on" };
const db = () => api.db.db;
const path = () => `/api/channels/${streamer.username}/chat/surge`;
const state = (p: Person) => p.client.call<State & { code?: string }>("GET", path());
const override = (p: Person, action: "start" | "end") =>
  p.client.call<State & { code?: string; data?: { requirement?: string } }>("POST", path(), { action });

async function guard(enabled: boolean) {
  await db()
    .update(schema.channels)
    .set({
      chatSettings: ChannelChatSettings.parse({
        surgeGuard: { enabled, triggerUnverifiedRatio: 0.5, cooldownMinutes: 5 },
      }),
    })
    .where(eq(schema.channels.id, channelId));
}

const records = () =>
  Promise.all([
    db()
      .select({ type: schema.events.type, payload: schema.events.payload })
      .from(schema.events)
      .where(and(eq(schema.events.channelId, channelId))),
    db()
      .select({ action: schema.auditLog.action, details: schema.auditLog.details, actorId: schema.auditLog.actorId })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.channelId, channelId), eq(schema.auditLog.action, "chat.surge.override"))),
  ]);
const surgeEvents = async () => (await records())[0].filter((e) => e.type.startsWith("chat.surge."));

beforeAll(async () => {
  api = await startApi();
  [streamer, mod, viewer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
  if (!c) throw new Error("no channel");
  channelId = c.id;
  await db().insert(schema.channelRoles).values({ channelId, userId: mod.userId, role: "moderator" });
}, 180_000);
afterAll(async () => {
  await api?.stop();
});
beforeEach(async () => {
  env().CHAT_SURGE_GUARD = "on";
  await guard(true);
  await api.deps.valkey.del(KEYS.surgeOverride(channelId));
});

describe("chat.surge", () => {
  test("state is off with no override; viewers are refused", async () => {
    const r = await state(mod);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ state: "off", since: null, until: null, by: null, unavailable: false });
    expect((await state(viewer)).status).toBe(403);
    expect((await override(viewer, "start")).status).toBe(403);
  });

  test("refused with the instance flag off, or with the channel's guard disabled", async () => {
    env().CHAT_SURGE_GUARD = "off";
    const off = await override(mod, "start");
    expect(off.status).toBe(412);
    expect(off.body.data).toEqual({ requirement: "surge_guard_off" });
    env().CHAT_SURGE_GUARD = "on";
    await guard(false);
    const disabled = await override(mod, "start");
    expect(disabled.status).toBe(412);
    expect(disabled.body.data).toEqual({ requirement: "surge_guard_disabled" });
    expect(await api.deps.valkey.get(KEYS.surgeOverride(channelId))).toBeNull();
    expect(await surgeEvents()).toHaveLength(0);
  });

  test("start then end: audited, begin/end events, the key and the surge frames", async () => {
    const sub = subscriber();
    const frames: Record<string, unknown>[] = [];
    sub.on("message", (_c: string, raw: string) => frames.push(JSON.parse(raw) as Record<string, unknown>));
    await sub.subscribe(BUS.chatControl(channelId));
    try {
      const started = await override(mod, "start");
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ state: "on", by: { id: mod.userId, username: mod.username } });
      const until = Date.parse(started.body.until ?? "");
      expect(until - Date.parse(started.body.since ?? "")).toBe(5 * 60_000);
      const ttl = await api.deps.valkey.ttl(KEYS.surgeOverride(channelId));
      expect(ttl).toBeGreaterThan(355);
      expect(ttl).toBeLessThanOrEqual(360);
      expect((await state(streamer)).body).toMatchObject({ state: "on", by: { username: mod.username } });

      const ended = await override(mod, "end");
      expect(ended.body).toMatchObject({ state: "suppressed", by: { id: mod.userId } });
      expect((await state(mod)).body.state).toBe("suppressed");

      const [events, audits] = await records();
      const surge = events.filter((e) => e.type.startsWith("chat.surge."));
      expect(surge).toEqual([
        {
          type: "chat.surge.begin",
          payload: { trigger: "moderator", until: started.body.until, by_user_id: mod.userId },
        },
        { type: "chat.surge.end", payload: { reason: "moderator", by_user_id: mod.userId } },
      ]);
      expect(audits.map((a) => a.details)).toEqual([{ action: "start" }, { action: "end" }]);
      expect(audits.every((a) => a.actorId === mod.userId)).toBe(true);

      await waitFor(async () => (frames.length >= 2 ? frames : null), 5_000, 20);
      expect(frames.map((f) => [f.op, f.state])).toEqual([
        ["surge", "on"],
        ["surge", "suppressed"],
      ]);
      expect(frames[0]).toMatchObject({ channel: streamer.username, until: started.body.until });
    } finally {
      await sub.quit();
    }
  });

  test("ending when surge mode is not on suppresses without an end event", async () => {
    const before = (await surgeEvents()).length;
    const r = await override(mod, "end");
    expect(r.body.state).toBe("suppressed");
    expect((await surgeEvents()).length).toBe(before);
  });
});
