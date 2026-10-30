// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `chat-surge-guard` pass against real Postgres (application role) and Valkey (ADR 0015
 * decision 6): a burst of unverified sessions begins surge mode (override, outbox and audit rows
 * in one transaction, the `surge` frame), the cooldown ends it, a lapsed key is recorded as
 * expired, a moderator's suppression blocks a re-trigger, a moderator's change between the read and
 * the write wins with nothing recorded, turning the guard off mid-surge ends it, and the flag off
 * does nothing.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { KEYS, SurgeOverride } from "@commonair/contracts/internal";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { schema as s, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey } from "@commonair/service";
import type { ChatGateConfig } from "../src/chat-gate/config.ts";
import { surgeOpenKey } from "../src/chat-gate/state.ts";
import { runSurgeGuard } from "../src/chat-gate/surge.ts";
import type { WorkerContext } from "../src/context.ts";
import { quietLogger, VALKEY_URL, waitFor } from "./fixtures.ts";

const ON: ChatGateConfig = { watchGate: true, surgeGuard: true, secret: "surge-guard-test-secret-0123456789abcdef" };
const valkey = createValkey(VALKEY_URL, { keyPrefix: `test:sg:${crypto.randomUUID()}:`, name: "worker-test-sg" });
const sub = createValkey(VALKEY_URL, { name: "worker-test-sg-sub" });
let t: TestDatabase;
let owner: Database;
let clock = new Date();
let ctx: WorkerContext;
const frames: { channel: string; frame: Record<string, unknown> }[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
  ctx = { db: t.app.db, valkey, logger: quietLogger, now: () => clock } as unknown as WorkerContext;
  await sub.psubscribe("chat-control:*");
  sub.on("pmessage", (_p, channel, message) => frames.push({ channel, frame: JSON.parse(message) }));
}, 180_000);
afterAll(async () => {
  await Promise.allSettled([valkey.quit(), sub.quit()]);
  await t?.drop();
});

const created: string[] = [];
// Each test's channels stop being scanned (and swept) afterwards, so result counts are this test's alone.
afterEach(async () => {
  for (const id of created.splice(0)) {
    await owner
      .update(s.channels)
      .set({ chatSettings: ChannelChatSettings.parse({}) })
      .where(eq(s.channels.id, id));
    await valkey.del(KEYS.surgeOverride(id), surgeOpenKey(id));
  }
});

let seq = 0;
const tag = () => `${++seq}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

async function guardedChannel(cooldownMinutes = 10) {
  const name = `sg${tag()}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, username: name, email: `${name}@example.test` })
    .returning({ id: s.users.id });
  if (!u) throw new Error("no user");
  const settings = ChannelChatSettings.parse({
    surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes },
  });
  const [c] = await owner
    .insert(s.channels)
    .values({ ownerId: u.id, slug: name, displayName: name, chatSettings: settings })
    .returning({ id: s.channels.id });
  if (!c) throw new Error("no channel");
  created.push(c.id);
  const broadcastId = uuidv7();
  await owner.insert(s.broadcasts).values({
    id: broadcastId,
    channelId: c.id,
    ingestProtocol: "rtmp",
    path: `live/${name}`,
    startedAt: new Date(clock.getTime() - 3_600_000),
  });
  await owner.update(s.channels).set({ liveBroadcastId: broadcastId }).where(eq(s.channels.id, c.id));
  return { id: c.id, slug: name, broadcastId };
}

/** `n` sessions started `agoSeconds` before the clock, verified or not. */
async function burst(ch: { id: string; broadcastId: string }, n: number, agoSeconds: number, verified = false) {
  await owner.insert(s.playbackSessions).values(
    Array.from({ length: n }, () => ({
      id: uuidv7(),
      channelId: ch.id,
      broadcastId: ch.broadcastId,
      deviceHash: `dev-${tag()}`,
      ipHash: `ip-${tag()}`,
      verdict: verified ? ("verified" as const) : ("pending" as const),
      verdictReasons: verified ? [] : ["media_unconfirmed"],
      scoredAt: clock,
      startedAt: new Date(clock.getTime() - agoSeconds * 1_000),
    })),
  );
}

const override = async (channelId: string) => {
  const raw = await valkey.get(KEYS.surgeOverride(channelId));
  return raw === null ? null : SurgeOverride.parse(JSON.parse(raw));
};
const rows = (channelId: string) =>
  Promise.all([
    owner
      .select({ type: s.events.type, payload: s.events.payload })
      .from(s.events)
      .where(eq(s.events.channelId, channelId)),
    owner
      .select({ action: s.auditLog.action, details: s.auditLog.details, actorType: s.auditLog.actorType })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.channelId, channelId), eq(s.auditLog.subjectType, "channel"))),
  ]);
const framesFor = (channelId: string) =>
  frames.filter((f) => f.channel === BUS.chatControl(channelId)).map((f) => f.frame);

describe("runSurgeGuard", () => {
  test("a burst of unverified sessions begins surge mode: override, outbox, audit, frame", async () => {
    clock = new Date();
    const ch = await guardedChannel();
    await burst(ch, 30, 90);
    const r = await runSurgeGuard(ctx, ON);
    expect(r.begun).toBe(1);
    const o = await override(ch.id);
    expect(o).toMatchObject({ state: "on", by: null });
    expect(Date.parse(o?.until ?? "")).toBe(clock.getTime() + 10 * 60_000);
    const ttl = await valkey.ttl(KEYS.surgeOverride(ch.id));
    expect(ttl).toBeGreaterThan(650);
    expect(ttl).toBeLessThanOrEqual(660);
    const [events, audits] = await rows(ch.id);
    expect(events).toEqual([
      { type: "chat.surge.begin", payload: { trigger: "new_sessions", until: o?.until, by_user_id: null } },
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "chat.surge.begin",
      actorType: "system",
      details: { trigger: "new_sessions" },
    });
    await waitFor(async () => framesFor(ch.id).length > 0, { timeoutMs: 3_000 });
    expect(framesFor(ch.id)[0]).toMatchObject({ op: "surge", channel: ch.slug, state: "on", until: o?.until });
    expect(await valkey.exists(surgeOpenKey(ch.id))).toBe(1);

    // Still triggered: extended, no second begin.
    clock = new Date(clock.getTime() + 60_000);
    await burst(ch, 30, 70);
    expect((await runSurgeGuard(ctx, ON)).begun).toBe(0);
    expect(Date.parse((await override(ch.id))?.until ?? "")).toBe(clock.getTime() + 10 * 60_000);
    expect((await rows(ch.id))[0]).toHaveLength(1);

    // Past the cooldown with no trigger: ended, key gone, end event and audit row.
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect((await runSurgeGuard(ctx, ON)).ended).toBe(1);
    expect(await override(ch.id)).toBeNull();
    const [after, afterAudit] = await rows(ch.id);
    expect(after.map((e) => e.type)).toEqual(["chat.surge.begin", "chat.surge.end"]);
    expect(after[1]?.payload).toEqual({ reason: "cooldown", by_user_id: null });
    expect(afterAudit.map((a) => a.action).sort()).toEqual(["chat.surge.begin", "chat.surge.end"]);
    expect(await valkey.exists(surgeOpenKey(ch.id))).toBe(0);
    await waitFor(async () => framesFor(ch.id).some((f) => f.state === "off"), { timeoutMs: 3_000 });
  });

  test("a mostly verified rush does not trip it; a follow burst does", async () => {
    clock = new Date();
    const ch = await guardedChannel();
    await burst(ch, 30, 90, true);
    expect((await runSurgeGuard(ctx, ON)).begun).toBe(0);
    await owner.insert(s.integrityFlags).values({
      subjectType: "channel",
      subjectId: ch.id,
      channelId: ch.id,
      signal: "follow_burst",
      score: 1,
      createdAt: new Date(clock.getTime() - 30_000),
    });
    expect((await runSurgeGuard(ctx, ON)).begun).toBe(1);
    expect((await rows(ch.id))[0][0]?.payload).toMatchObject({ trigger: "follow_burst" });
  });

  test("a key that lapsed without an end event is recorded as expired", async () => {
    clock = new Date();
    const ch = await guardedChannel();
    await burst(ch, 30, 90);
    await runSurgeGuard(ctx, ON);
    await valkey.del(KEYS.surgeOverride(ch.id));
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect((await runSurgeGuard(ctx, ON)).ended).toBe(1);
    const [events] = await rows(ch.id);
    expect(events.map((e) => e.payload)).toContainEqual({ reason: "expired", by_user_id: null });
    expect(await valkey.exists(surgeOpenKey(ch.id))).toBe(0);
  });

  test("suppressed by a moderator: no re-trigger before until", async () => {
    clock = new Date();
    const ch = await guardedChannel();
    await valkey.set(
      KEYS.surgeOverride(ch.id),
      JSON.stringify({
        state: "suppressed",
        since: clock.toISOString(),
        until: new Date(clock.getTime() + 600_000).toISOString(),
        by: null,
      }),
      "EX",
      660,
    );
    await burst(ch, 40, 90);
    expect((await runSurgeGuard(ctx, ON)).begun).toBe(0);
    expect((await override(ch.id))?.state).toBe("suppressed");
    expect((await rows(ch.id))[0]).toHaveLength(0);
  });

  test("a moderator's override between the read and the write wins: nothing is recorded", async () => {
    clock = new Date();
    const ch = await guardedChannel();
    await burst(ch, 30, 90);
    const theirs = JSON.stringify({
      state: "suppressed",
      since: clock.toISOString(),
      until: new Date(clock.getTime() + 600_000).toISOString(),
      by: null,
    });
    // The API's write lands just before the job's compare-and-set.
    let raced = false;
    const racing = new Proxy(valkey, {
      get(target, prop, receiver) {
        if (prop === "eval" && !raced)
          return async (...args: Parameters<typeof valkey.eval>) => {
            raced = true;
            await target.set(KEYS.surgeOverride(ch.id), theirs, "EX", 660);
            return target.eval(...args);
          };
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const r = await runSurgeGuard({ ...ctx, valkey: racing } as WorkerContext, ON);
    expect(raced).toBe(true);
    expect(r.begun).toBe(0);
    expect(await valkey.get(KEYS.surgeOverride(ch.id))).toBe(theirs);
    expect(await valkey.exists(surgeOpenKey(ch.id))).toBe(0);
    expect(await rows(ch.id)).toEqual([[], []]);
    expect(framesFor(ch.id)).toEqual([]);
  });

  test("turning the guard off mid-surge ends it: end event, audit, keys gone, off frame", async () => {
    clock = new Date();
    const ch = await guardedChannel();
    await burst(ch, 30, 90);
    expect((await runSurgeGuard(ctx, ON)).begun).toBe(1);
    await owner
      .update(s.channels)
      .set({ chatSettings: ChannelChatSettings.parse({}) })
      .where(eq(s.channels.id, ch.id));
    clock = new Date(clock.getTime() + 30_000);
    const r = await runSurgeGuard(ctx, ON);
    expect(r.ended).toBe(1);
    expect(await override(ch.id)).toBeNull();
    expect(await valkey.exists(surgeOpenKey(ch.id))).toBe(0);
    const [events, audits] = await rows(ch.id);
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ trigger: "new_sessions" }),
      { reason: "cooldown", by_user_id: null },
    ]);
    expect(audits.find((a) => a.action === "chat.surge.end")?.details).toEqual({
      reason: "cooldown",
      cause: "guard_disabled",
    });
    await waitFor(async () => framesFor(ch.id).some((f) => f.state === "off"), { timeoutMs: 3_000 });
    // Nothing left: the next run does nothing more.
    expect((await runSurgeGuard(ctx, ON)).ended).toBe(0);
  });

  test("a moderator's suppression left on an unguarded channel is cleared quietly", async () => {
    clock = new Date();
    const ch = await guardedChannel();
    await owner
      .update(s.channels)
      .set({ chatSettings: ChannelChatSettings.parse({}) })
      .where(eq(s.channels.id, ch.id));
    await valkey.set(
      KEYS.surgeOverride(ch.id),
      JSON.stringify({ state: "suppressed", since: clock.toISOString(), until: clock.toISOString(), by: null }),
      "EX",
      660,
    );
    expect((await runSurgeGuard(ctx, ON)).ended).toBe(0);
    expect(await override(ch.id)).toBeNull();
    expect((await rows(ch.id))[0]).toHaveLength(0);
  });

  test("CHAT_SURGE_GUARD off: nothing is read or written", async () => {
    clock = new Date();
    const ch = await guardedChannel();
    await burst(ch, 30, 90);
    expect(await runSurgeGuard(ctx, { ...ON, surgeGuard: false })).toEqual({ channels: 0, begun: 0, ended: 0 });
    expect(await override(ch.id)).toBeNull();
  });
});
