// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The go-live email digest sweep (ADR 0028 decision 3; N1-email) against real Postgres. */
import type { GoLiveSetting } from "@commonair/contracts/shapes";
import { schema, uuidv7, type Database } from "@commonair/db";
import { MemoryMailer, type Mailer } from "@commonair/email";
import { verifyUnsubscribeToken } from "@commonair/tokens";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { DIGEST_STALE_AFTER_MS, sweepEmailDigests } from "../src/notify/email/digest.ts";
import { clearGoLiveSettingCache, goLiveSetting } from "../src/notify/settings.ts";
import { siteAt } from "./e6-fixtures.ts";
import { AUTH_SECRET, makeBroadcast, makeUser, quietLogger, setup, type TestEnv } from "./fixtures.ts";

const site = siteAt("http://air.example.test");
const MIN = 60_000;
let env: TestEnv;

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.t.db.delete(schema.notificationEmailQueue);
  await pinWindow(5);
});

const db = (): Database => env.t.db;
const q = schema.notificationEmailQueue;

/**
 * Pin `notifications.goLive` for the sweep: prime the reader's 30 s cache with the value (the
 * governance setting itself only changes through a decision, which this test does not need).
 */
async function pinWindow(emailDigestMinutes: number): Promise<void> {
  clearGoLiveSettingCache();
  const value: GoLiveSetting = { cooldownHours: 4, emailDigestMinutes };
  const fake = {
    select: () => ({ from: () => ({ where: async () => [{ value }] }) }),
  } as unknown as Pick<Database, "select">;
  await goLiveSetting(fake, quietLogger);
}

/** The worker's context with a pinned clock (the code's clock, never Postgres's) and a mailer. */
function context(mailer: Mailer, now: Date): WorkerContext {
  return { ...env.worker.ctx, mailer, site, now: () => now };
}

interface Member {
  id: string;
  email: string;
}

async function member(opts: { verified?: boolean; matureConfirmed?: boolean; defaultEmail?: boolean } = {}) {
  const { user } = await makeUser(db());
  await db()
    .update(schema.users)
    .set({
      emailVerified: opts.verified ?? true,
      matureConfirmedAt: opts.matureConfirmed ? new Date() : null,
    })
    .where(eq(schema.users.id, user.id));
  if (opts.defaultEmail ?? true)
    await db()
      .insert(schema.notificationPreferences)
      .values({ userId: user.id, type: "go_live", channelId: null, medium: "email", enabled: true });
  return { id: user.id, email: user.email } satisfies Member;
}

interface Live {
  channelId: string;
  slug: string;
  broadcastId: string;
}

async function liveChannel(opts: { title?: string; mature?: boolean; channelMature?: boolean } = {}): Promise<Live> {
  const { channel } = await makeUser(db());
  if (opts.channelMature)
    await db().update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, channel.id));
  const b = await makeBroadcast(db(), channel.id);
  await db()
    .update(schema.broadcasts)
    .set({ title: opts.title ?? `Title of ${channel.slug}`, mature: opts.mature ?? false })
    .where(eq(schema.broadcasts.id, b.id));
  return { channelId: channel.id, slug: channel.slug, broadcastId: b.id };
}

/** The follow (bell on) and a queued go-live row, as N1-fanout writes them. */
async function queue(m: Member, live: Live, queuedAt: Date, opts: { follow?: boolean } = {}): Promise<string> {
  if (opts.follow ?? true)
    await db()
      .insert(schema.follows)
      .values({ followerId: m.id, channelId: live.channelId, notify: true })
      .onConflictDoNothing();
  const eventId = uuidv7();
  await db()
    .insert(q)
    .values({ userId: m.id, eventId, channelId: live.channelId, broadcastId: live.broadcastId, queuedAt });
  return eventId;
}

const queued = async (userId: string) => (await db().select().from(q).where(eq(q.userId, userId))).length;
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

describe("sweepEmailDigests", () => {
  test("rows older than the window: one email to the verified address with every channel, rows deleted", async () => {
    const now = new Date();
    const m = await member();
    const a = await liveChannel({ title: "Speedrun night" });
    const b = await liveChannel({ title: "Cozy builds" });
    await queue(m, a, ago(now, 6 * MIN));
    await queue(m, b, ago(now, 1 * MIN));
    const mailer = new MemoryMailer({ site });
    expect(await sweepEmailDigests(context(mailer, now))).toEqual({ users: 1, sent: 1 });
    const [mail, ...rest] = mailer.to(m.email);
    expect(rest).toHaveLength(0);
    expect(mail?.template).toBe("goLiveDigest");
    expect(mail?.html).toContain(`href="${site.publicUrl}/${a.slug}"`);
    expect(mail?.html).toContain(`href="${site.publicUrl}/${b.slug}"`);
    expect(mail?.text).toContain("Speedrun night");
    expect(mail?.text).toContain("Cozy builds");
    expect(mail?.html).toContain(`href="${site.publicUrl}/settings/notifications"`);
    // RFC 8058: the token in the header is the member's, for the go_live list.
    const header = mail?.headers["List-Unsubscribe"] ?? "";
    const url = new URL(header.slice(1, -1));
    expect(url.origin + url.pathname).toBe(`${site.publicUrl}/api/email/unsubscribe`);
    expect(url.searchParams.get("list")).toBe("go_live");
    expect(await verifyUnsubscribeToken(AUTH_SECRET, url.searchParams.get("token") ?? "", "go_live")).toBe(m.id);
    expect(mail?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(await queued(m.id)).toBe(0);
  });

  test("younger than the window: nothing yet, rows kept", async () => {
    const now = new Date();
    const m = await member();
    await queue(m, await liveChannel(), ago(now, 4 * MIN));
    const mailer = new MemoryMailer({ site });
    expect(await sweepEmailDigests(context(mailer, now))).toEqual({ users: 0, sent: 0 });
    expect(mailer.sent).toHaveLength(0);
    expect(await queued(m.id)).toBe(1);
  });

  test("window 0: sent at the next sweep", async () => {
    await pinWindow(0);
    const now = new Date();
    const m = await member();
    await queue(m, await liveChannel(), now);
    const mailer = new MemoryMailer({ site });
    expect(await sweepEmailDigests(context(mailer, now))).toEqual({ users: 1, sent: 1 });
    expect(mailer.to(m.email)).toHaveLength(1);
  });

  test("two members: two emails", async () => {
    const now = new Date();
    const live = await liveChannel();
    const [m1, m2] = [await member(), await member()];
    await queue(m1, live, ago(now, 10 * MIN));
    await queue(m2, live, ago(now, 7 * MIN));
    const mailer = new MemoryMailer({ site });
    expect(await sweepEmailDigests(context(mailer, now))).toEqual({ users: 2, sent: 2 });
    expect(mailer.to(m1.email)).toHaveLength(1);
    expect(mailer.to(m2.email)).toHaveLength(1);
  });

  test("opted out since queuing (override off, unfollowed, bell off): no email, rows gone", async () => {
    const now = new Date();
    const mailer = new MemoryMailer({ site });

    const offOverride = await member();
    const a = await liveChannel();
    await queue(offOverride, a, ago(now, 6 * MIN));
    await db()
      .insert(schema.notificationPreferences)
      .values({ userId: offOverride.id, type: "go_live", channelId: a.channelId, medium: "email", enabled: false });

    const unfollowed = await member();
    await queue(unfollowed, await liveChannel(), ago(now, 6 * MIN), { follow: false });

    const bellOff = await member();
    const c = await liveChannel();
    await queue(bellOff, c, ago(now, 6 * MIN));
    await db().update(schema.follows).set({ notify: false }).where(eq(schema.follows.followerId, bellOff.id));

    const defaultOff = await member({ defaultEmail: false });
    await queue(defaultOff, await liveChannel(), ago(now, 6 * MIN));

    expect(await sweepEmailDigests(context(mailer, now))).toEqual({ users: 4, sent: 0 });
    expect(mailer.sent).toHaveLength(0);
    for (const m of [offOverride, unfollowed, bellOff, defaultOff]) expect(await queued(m.id)).toBe(0);
  });

  test("a digest drops only the channels opted out of since queuing", async () => {
    const now = new Date();
    const m = await member();
    const kept = await liveChannel();
    const dropped = await liveChannel();
    await queue(m, kept, ago(now, 6 * MIN));
    await queue(m, dropped, ago(now, 6 * MIN));
    await db()
      .insert(schema.notificationPreferences)
      .values({ userId: m.id, type: "go_live", channelId: dropped.channelId, medium: "email", enabled: false });
    const mailer = new MemoryMailer({ site });
    await sweepEmailDigests(context(mailer, now));
    const [mail] = mailer.to(m.email);
    expect(mail?.html).toContain(`/${kept.slug}"`);
    expect(mail?.html).not.toContain(`/${dropped.slug}"`);
    expect(await queued(m.id)).toBe(0);
  });

  test("unverified since queuing: no email, rows gone", async () => {
    const now = new Date();
    const m = await member({ verified: false });
    await queue(m, await liveChannel(), ago(now, 6 * MIN));
    const mailer = new MemoryMailer({ site });
    expect(await sweepEmailDigests(context(mailer, now))).toEqual({ users: 1, sent: 0 });
    expect(mailer.sent).toHaveLength(0);
    expect(await queued(m.id)).toBe(0);
  });

  test("a send that throws keeps the rows for the next sweep", async () => {
    const now = new Date();
    const m = await member();
    await queue(m, await liveChannel(), ago(now, 6 * MIN));
    const failing: Mailer = {
      send: () => Promise.reject(new Error("smtp down")),
      close: async () => {},
    };
    expect(await sweepEmailDigests(context(failing, now))).toEqual({ users: 1, sent: 0 });
    expect(await queued(m.id)).toBe(1);
    const mailer = new MemoryMailer({ site });
    expect(await sweepEmailDigests(context(mailer, now))).toEqual({ users: 1, sent: 1 });
    expect(await queued(m.id)).toBe(0);
  });

  test("rows older than the window plus an hour are dropped without mail", async () => {
    const now = new Date();
    const m = await member();
    await queue(m, await liveChannel(), ago(now, 5 * MIN + DIGEST_STALE_AFTER_MS + MIN));
    const mailer = new MemoryMailer({ site });
    expect(await sweepEmailDigests(context(mailer, now))).toEqual({ users: 0, sent: 0 });
    expect(mailer.sent).toHaveLength(0);
    expect(await queued(m.id)).toBe(0);
  });

  test("two concurrent sweeps send one email (skip locked)", async () => {
    const now = new Date();
    const m = await member();
    await queue(m, await liveChannel(), ago(now, 6 * MIN));
    await queue(m, await liveChannel(), ago(now, 6 * MIN));
    const memory = new MemoryMailer({ site });
    // A slow send holds the first sweep's lock while the second one looks.
    const slow: Mailer = {
      send: async (template, props, to) => {
        await Bun.sleep(300);
        return memory.send(template, props, to);
      },
      close: async () => {},
    };
    const results = await Promise.all([sweepEmailDigests(context(slow, now)), sweepEmailDigests(context(slow, now))]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(memory.to(m.email)).toHaveLength(1);
    expect(await queued(m.id)).toBe(0);
  });

  test("a mature stream shows no title to a member who has not confirmed 18+", async () => {
    const now = new Date();
    const unconfirmed = await member();
    const confirmed = await member({ matureConfirmed: true });
    const broadcastMature = await liveChannel({ title: "Late night horror", mature: true });
    const channelMature = await liveChannel({ title: "Labelled later", channelMature: true });
    for (const m of [unconfirmed, confirmed]) {
      await queue(m, broadcastMature, ago(now, 6 * MIN));
      await queue(m, channelMature, ago(now, 6 * MIN));
    }
    const mailer = new MemoryMailer({ site });
    await sweepEmailDigests(context(mailer, now));
    const hidden = mailer.to(unconfirmed.email)[0];
    expect(hidden?.text).not.toContain("Late night horror");
    expect(hidden?.text).not.toContain("Labelled later");
    expect(hidden?.html).toContain(`/${broadcastMature.slug}"`);
    const shown = mailer.to(confirmed.email)[0];
    expect(shown?.text).toContain("Late night horror");
    expect(shown?.text).toContain("Labelled later");
  });

  test("without a mailer the sweep does nothing", async () => {
    const now = new Date();
    const m = await member();
    await queue(m, await liveChannel(), ago(now, 6 * MIN));
    const { mailer: _drop, ...rest } = context(new MemoryMailer({ site }), now);
    expect(await sweepEmailDigests(rest)).toEqual({ users: 0, sent: 0 });
    expect(await queued(m.id)).toBe(1);
  });
});
