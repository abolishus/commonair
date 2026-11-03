// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 decision (g): Better Auth's admin plugin clears a lapsed ban when the member signs in,
 * through `databaseHooks.user.update`. The hook then writes `channel.suspension {suspended: false}`
 * for the member's channel, exactly once: not again on a second sign-in, not twice with two sign-ins
 * at once, and not twice when the `ban-expiry` sweep races it. A channel suspended in its own
 * right, and a member with no channel, get no event.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { recordLapsedUnsuspension, recordLapsedWithRetry } from "../src/auth/index.ts";
import { emit } from "../src/events/outbox.ts";
import { setSuspension } from "../src/moderation/suspension.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";
import { suspensions } from "./media-state-helpers.ts";

const { users, channels } = schema;

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;

type Member = Awaited<ReturnType<typeof signUpAndSignIn>> & { channelId: string };

async function member(): Promise<Member> {
  const m = await signUpAndSignIn(api);
  const [c] = await db().select({ id: channels.id }).from(channels).where(eq(channels.ownerId, m.userId));
  if (!c) throw new Error("no channel");
  return { ...m, channelId: c.id };
}

/** A timed account suspension through the audited path (its `suspended: true` event), then lapsed. */
async function lapsedBan(m: Member): Promise<void> {
  const now = new Date();
  await db().transaction((tx) => setSuspension(tx, { userId: m.userId, channelId: null }, "user", true, now, 3600));
  await db()
    .update(users)
    .set({ banExpires: new Date(Date.now() - 60_000) })
    .where(eq(users.id, m.userId));
}

const signIn = (m: Member) =>
  client(api).call("POST", "/api/auth/sign-in/email", { email: m.email, password: m.password });

async function banned(userId: string): Promise<boolean> {
  const [u] = await db().select({ banned: users.banned }).from(users).where(eq(users.id, userId));
  return u?.banned === true;
}

/** Wait for the after hook, which runs after the sign-in answered. */
async function settled(channelId: string, length: number): Promise<unknown[]> {
  for (let i = 0; i < 50; i++) {
    const s = await suspensions(db(), channelId);
    if (s.length >= length) return s;
    await Bun.sleep(100);
  }
  return suspensions(db(), channelId);
}

describe("a lapsed ban cleared at sign-in (decision (g))", () => {
  test("writes one unsuspension; a second sign-in writes none", async () => {
    const m = await member();
    await lapsedBan(m);
    expect(await suspensions(db(), m.channelId)).toEqual([true]);

    const r = await signIn(m);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await banned(m.userId)).toBe(false);
    expect(await settled(m.channelId, 2)).toEqual([true, false]);

    expect((await signIn(m)).status).toBe(200);
    await Bun.sleep(300);
    expect(await suspensions(db(), m.channelId)).toEqual([true, false]);
  });

  test("two sign-ins at once write one", async () => {
    const m = await member();
    await lapsedBan(m);
    const [a, b] = await Promise.all([signIn(m), signIn(m)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await settled(m.channelId, 2)).toEqual([true, false]);
    await Bun.sleep(300);
    expect(await suspensions(db(), m.channelId)).toEqual([true, false]);
  });

  test("the ban-expiry sweep racing the sign-in: still one", async () => {
    const m = await member();
    await lapsedBan(m);
    // The sweep's transaction (services/worker/src/moderation/ban-expiry.ts): lock the channels,
    // clear the ban only while it is still set, and write the unsuspension when it did.
    const sweep = () =>
      db().transaction(async (tx) => {
        await tx.select({ id: channels.id }).from(channels).where(eq(channels.ownerId, m.userId)).for("update");
        const cleared = await tx
          .update(users)
          .set({ banned: false, banReason: null, banExpires: null })
          .where(and(eq(users.id, m.userId), eq(users.banned, true)))
          .returning({ id: users.id });
        if (cleared.length > 0)
          await emit(tx, "channel.suspension", m.channelId, { channel_id: m.channelId, suspended: false });
        return cleared.length;
      });
    const [r] = await Promise.all([signIn(m), sweep()]);
    expect(r.status).toBe(200);
    expect(await settled(m.channelId, 2)).toEqual([true, false]);
    await Bun.sleep(300);
    expect(await suspensions(db(), m.channelId)).toEqual([true, false]);

    // And the sweep first, then the sign-in: the sign-in finds the ban gone and writes nothing.
    const n = await member();
    await lapsedBan(n);
    await db().transaction(async (tx) => {
      await tx.update(users).set({ banned: false, banReason: null, banExpires: null }).where(eq(users.id, n.userId));
      await emit(tx, "channel.suspension", n.channelId, { channel_id: n.channelId, suspended: false });
    });
    expect((await signIn(n)).status).toBe(200);
    await Bun.sleep(300);
    expect(await suspensions(db(), n.channelId)).toEqual([true, false]);
  });

  test("a channel suspended in its own right stays suspended: no event", async () => {
    const m = await member();
    await lapsedBan(m);
    await db().update(channels).set({ suspendedAt: new Date() }).where(eq(channels.id, m.channelId));
    expect((await signIn(m)).status).toBe(200);
    await Bun.sleep(300);
    expect(await banned(m.userId)).toBe(false);
    expect(await suspensions(db(), m.channelId)).toEqual([true]);
  });

  test("a ban still in force is refused, and nothing is written", async () => {
    const m = await member();
    await db().transaction((tx) =>
      setSuspension(tx, { userId: m.userId, channelId: null }, "user", true, new Date(), 3600),
    );
    expect((await signIn(m)).status).toBe(403);
    expect(await suspensions(db(), m.channelId)).toEqual([true]);
  });
});

describe("recordLapsedUnsuspension", () => {
  test("a member with no channel: nothing to write", async () => {
    const id = uuidv7();
    await db()
      .insert(users)
      .values({ id, name: "nochannel", email: `nochannel-${id}@test.invalid`, username: `nc${id.slice(-8)}` });
    expect(await recordLapsedUnsuspension(db(), id, new Date())).toBe(0);
  });

  test("never undoes what no event announced, nor what is already undone", async () => {
    const m = await member();
    // No suspension event at all: nothing to undo.
    expect(await recordLapsedUnsuspension(db(), m.userId, new Date())).toBe(0);
    await lapsedBan(m);
    await db().update(users).set({ banned: false, banExpires: null }).where(eq(users.id, m.userId));
    expect(await recordLapsedUnsuspension(db(), m.userId, new Date())).toBe(1);
    expect(await recordLapsedUnsuspension(db(), m.userId, new Date())).toBe(0);
    const [{ n }] = (await db().execute(
      sql`select count(*)::int as n from events where channel_id = ${m.channelId}::uuid and type = 'channel.suspension'`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(2);
  });
});

describe("only the update that clears a ban", () => {
  test("a profile update writes nothing, even with an unsuspension owed", async () => {
    const m = await member();
    await lapsedBan(m);
    // Owed, but cleared outside the sign-in: the hook must not pick it up on an unrelated update.
    await db().update(users).set({ banned: false, banExpires: null }).where(eq(users.id, m.userId));
    // The suspension revoked the session: sign in again (no ban to clear, so nothing either).
    const s = await m.client.call("POST", "/api/auth/sign-in/email", { email: m.email, password: m.password });
    expect(s.status).toBe(200);
    const r = await m.client.call("POST", "/api/auth/update-user", { name: "Renamed" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await Bun.sleep(300);
    expect(await suspensions(db(), m.channelId)).toEqual([true]);
  });
});

describe("recordLapsedWithRetry", () => {
  const logs = () => {
    const out: { level: string; msg: string }[] = [];
    return {
      out,
      logger: {
        warn: (msg: string) => out.push({ level: "warn", msg }),
        error: (msg: string) => out.push({ level: "error", msg }),
      },
    };
  };

  test("a failed first attempt is retried once and writes the event", async () => {
    const m = await member();
    await lapsedBan(m);
    await db().update(users).set({ banned: false, banExpires: null }).where(eq(users.id, m.userId));
    let calls = 0;
    const flaky = {
      transaction: ((fn: never) =>
        calls++ === 0 ? Promise.reject(new Error("serialization")) : db().transaction(fn)) as never,
    } as unknown as Parameters<typeof recordLapsedWithRetry>[0];
    const { out, logger } = logs();
    expect(await recordLapsedWithRetry(flaky, m.userId, new Date(), logger)).toBe(1);
    expect(calls).toBe(2);
    expect(out.map((l) => l.level)).toEqual(["warn"]);
    expect(await suspensions(db(), m.channelId)).toEqual([true, false]);
  });

  test("two failures log at error level and give up", async () => {
    const failing = {
      transaction: () => Promise.reject(new Error("down")),
    } as unknown as Parameters<typeof recordLapsedWithRetry>[0];
    const { out, logger } = logs();
    expect(await recordLapsedWithRetry(failing, uuidv7(), new Date(), logger)).toBeNull();
    expect(out.map((l) => l.level)).toEqual(["warn", "error"]);
  });
});
