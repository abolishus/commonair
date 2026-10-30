// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.discord.{get,set,remove,test}` (ADR 0028 decision 5): a write-only secret per channel. */
import { NOTIFY_SECRET_PURPOSES } from "@commonair/contracts/notify";
import { schema } from "@commonair/db";
import { decryptSecret } from "@commonair/tokens";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { Deps } from "../src/deps.ts";
import { setNotifyQueue } from "../src/notifications/queue.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
/** Test posts the fake producer took, deduped by the producer's job id like BullMQ. */
const testJobs = new Set<string>();
const testCalls: { channelId: string; minute: number }[] = [];

beforeAll(async () => {
  api = await startApi();
  setNotifyQueue(api.deps, {
    enqueueDiscordTest: async (channelId, minute) => {
      testCalls.push({ channelId, minute });
      testJobs.add(`discord-test-${channelId}-${minute}`);
    },
    close: async () => {},
  });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
type Member = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Status {
  configured: boolean;
  setAt: string | null;
  lastPostedAt: string | null;
  lastError: string | null;
}

const hookUrl = (n = 1) => `https://discord.com/api/webhooks/12345678901234567${n}/Secret_Token-${crypto.randomUUID()}`;
const base = (slug: string) => `/api/channels/${slug}/discord-webhook`;
const get = (m: Member, slug = m.username) => m.client.call<Status>("GET", base(slug));
const set = (m: Member, url: string, slug = m.username) => m.client.call<Status>("PUT", base(slug), { url });
const remove = (m: Member, slug = m.username) => m.client.call<{ ok: true }>("DELETE", base(slug));
const sendTest = (m: Member, slug = m.username) => m.client.call<Status>("POST", `${base(slug)}/test`);

async function channelOf(m: Member) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, m.username));
  return c!;
}
const rowOf = async (channelId: string) =>
  (await db().select().from(schema.discordWebhooks).where(eq(schema.discordWebhooks.channelId, channelId)))[0];
const auditsOf = (channelId: string) =>
  db().select().from(schema.auditLog).where(eq(schema.auditLog.channelId, channelId));

/** Pin the API's clock for `fn`. */
async function at<T>(when: Date, fn: () => Promise<T>): Promise<T> {
  const deps = api.deps as { now: Deps["now"] };
  const before = deps.now;
  deps.now = () => when;
  try {
    return await fn();
  } finally {
    deps.now = before;
  }
}

describe("notifications.discord", () => {
  test("not configured → set (sealed, never echoed) → get → remove", async () => {
    const m = await signUpAndSignIn(api);
    const c = await channelOf(m);
    expect((await get(m)).body).toEqual({ configured: false, setAt: null, lastPostedAt: null, lastError: null });

    const url = hookUrl();
    const r = await set(m, url);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, lastPostedAt: null, lastError: null });
    expect(typeof r.body.setAt).toBe("string");
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain("Secret_Token");
    expect(raw).not.toContain("discord.com");

    const row = await rowOf(c.id);
    expect(row?.url).not.toContain("discord.com");
    expect(await decryptSecret(api.deps.env.AUTH_SECRET, NOTIFY_SECRET_PURPOSES.discordWebhook, row!.url)).toBe(url);
    expect(row?.setBy).toBe(m.userId);

    const g = await get(m);
    expect(g.body).toEqual(r.body);
    expect(JSON.stringify(g.body)).not.toContain("Secret_Token");

    expect((await remove(m)).body).toEqual({ ok: true });
    expect(await rowOf(c.id)).toBeUndefined();
    expect((await get(m)).body.configured).toBe(false);
    // Removing again is fine.
    expect((await remove(m)).status).toBe(200);
  });

  test("set resets failures and the last error, keeps the last post", async () => {
    const m = await signUpAndSignIn(api);
    const c = await channelOf(m);
    await set(m, hookUrl(1));
    const posted = new Date("2026-10-30T10:00:00Z");
    await db()
      .update(schema.discordWebhooks)
      .set({ failures: 2, lastError: "not_found", lastPostedAt: posted })
      .where(eq(schema.discordWebhooks.channelId, c.id));
    expect((await get(m)).body).toMatchObject({ lastError: "not_found", lastPostedAt: posted.toISOString() });
    const r = await set(m, hookUrl(2));
    expect(r.body).toMatchObject({ configured: true, lastError: null, lastPostedAt: posted.toISOString() });
    expect((await rowOf(c.id))?.failures).toBe(0);
  });

  test("a URL that is not a Discord webhook is refused by the contract", async () => {
    const m = await signUpAndSignIn(api);
    const c = await channelOf(m);
    for (const url of [
      "https://evil.example/api/webhooks/1/abc",
      "http://discord.com/api/webhooks/1/abc",
      "https://discord.com.evil.example/api/webhooks/1/abc",
      "https://discord.com/api/webhooks/1/abc?wait=true",
      "https://discord.com/api/webhooks/abc/abc",
      "https://user:pw@discord.com/api/webhooks/1/abc",
      `https://discord.com/api/webhooks/1/${"a".repeat(300)}`,
    ]) {
      const r = await set(m, url);
      expect(r.status, url).toBe(400);
      expect(JSON.stringify(r.body)).not.toContain(url);
    }
    expect(await rowOf(c.id)).toBeUndefined();
    // discordapp.com is Discord's older host.
    expect((await set(m, "https://discordapp.com/api/webhooks/1/abc_DEF-9")).status).toBe(200);
  });

  test("only the owner or an editor: anyone else is refused and signed-out callers too", async () => {
    const ownerM = await signUpAndSignIn(api);
    const other = await signUpAndSignIn(api);
    const editor = await signUpAndSignIn(api);
    const c = await channelOf(ownerM);
    await db().insert(schema.channelRoles).values({ channelId: c.id, userId: editor.userId, role: "editor" });

    for (const r of [
      await get(other, ownerM.username),
      await set(other, hookUrl(), ownerM.username),
      await remove(other, ownerM.username),
      await sendTest(other, ownerM.username),
    ])
      expect(r.status).toBe(403);
    expect(await rowOf(c.id)).toBeUndefined();

    const anon = await fetch(`${api.url}${base(ownerM.username)}`);
    expect(anon.status).toBe(401);

    expect((await set(editor, hookUrl(), ownerM.username)).status).toBe(200);
    expect((await rowOf(c.id))?.setBy).toBe(editor.userId);
    expect((await get(ownerM)).body.configured).toBe(true);
  });

  test("set, remove and test write audit rows naming the action only, never the URL", async () => {
    const m = await signUpAndSignIn(api);
    const c = await channelOf(m);
    const url = hookUrl();
    await set(m, url);
    await sendTest(m);
    await remove(m);
    const rows = await auditsOf(c.id);
    expect(rows.map((r) => [r.action, r.details, r.actorType, r.actorId, r.subjectType, r.subjectId])).toEqual([
      ["discord_webhook.set", { action: "set" }, "user", m.userId, "channel", c.id],
      ["discord_webhook.test", { action: "test" }, "user", m.userId, "channel", c.id],
      ["discord_webhook.remove", { action: "remove" }, "user", m.userId, "channel", c.id],
    ]);
    const all = JSON.stringify(rows);
    expect(all).not.toContain("Secret_Token");
    expect(all).not.toContain("discord.com");
  });

  test("a test post is one job per channel and minute; the call returns the current status", async () => {
    const m = await signUpAndSignIn(api);
    const c = await channelOf(m);
    const t0 = new Date("2026-10-30T12:00:05Z");
    // Nothing configured: nothing to post.
    const none = await at(t0, () => sendTest(m));
    expect(none.body.configured).toBe(false);
    expect(testCalls.filter((x) => x.channelId === c.id)).toHaveLength(0);

    await set(m, hookUrl());
    const r1 = await at(t0, () => sendTest(m));
    expect(r1.status).toBe(200);
    expect(r1.body.configured).toBe(true);
    expect(JSON.stringify(r1.body)).not.toContain("Secret_Token");
    await at(new Date("2026-10-30T12:00:55Z"), () => sendTest(m));
    const mine = () => [...testJobs].filter((id) => id.includes(c.id));
    expect(mine()).toEqual([`discord-test-${c.id}-${Math.floor(t0.getTime() / 60_000)}`]);
    await at(new Date("2026-10-30T12:01:00Z"), () => sendTest(m));
    expect(mine()).toHaveLength(2);
  });
});
