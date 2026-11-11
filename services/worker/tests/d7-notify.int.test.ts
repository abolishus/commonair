// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 4, D7.3 (d7-notify) against real Postgres and Valkey: the weekly "What you missed"
 * email (eligible members, empty weeks skipped, once per week, unsubscribe, deletion) and the
 * creator's "Your video is ready" email.
 */
import { DIGEST_RULES } from "@commonair/contracts/enums";
import { schema, uuidv7, type Database } from "@commonair/db";
import { MemoryMailer, type Mailer } from "@commonair/email";
import { verifyUnsubscribeToken } from "@commonair/tokens";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { JOBS } from "../src/jobs/index.ts";
import { job as vodJob, VOD_EMAIL_JOB } from "../src/jobs/notify-vod-email.ts";
import { job as weeklyJob, WEEKLY_DIGEST_JOB } from "../src/jobs/notify-weekly-digest.ts";
import { sweepVodReadyEmails, VOD_EMAIL_WINDOW_MS } from "../src/notify/vod/email.ts";
import { runWeeklyDigest, weekStartOf } from "../src/notify/weekly/digest.ts";
import { siteAt } from "./e6-fixtures.ts";
import { AUTH_SECRET, makeBroadcast, makeUser, setup, type TestEnv } from "./fixtures.ts";

const site = siteAt("http://air.example.test");
let env: TestEnv;

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(() => env.close());

const db = (): Database => env.t.db;
const sends = schema.notificationDigestSends;

/** A send-window time: the digest weekday at the send hour, in a far week so runs do not collide. */
let weeks = 0;
function sendTime(): Date {
  weeks += 1;
  // 2030-01-07 is a Monday.
  const monday = Date.UTC(2030, 0, 7) + weeks * 7 * 86_400_000;
  const day = monday + ((DIGEST_RULES.weekdayUtc + 6) % 7) * 86_400_000;
  return new Date(day + DIGEST_RULES.sendHourUtc * 3_600_000 + 5 * 60_000);
}

function context(mailer: Mailer, now: Date): WorkerContext {
  return { ...env.worker.ctx, mailer, site, now: () => now };
}

async function member(opts: { verified?: boolean; optIn?: boolean } = {}) {
  const { user } = await makeUser(db());
  await db()
    .update(schema.users)
    .set({ emailVerified: opts.verified ?? true })
    .where(eq(schema.users.id, user.id));
  if (opts.optIn ?? true)
    await db()
      .insert(schema.notificationPreferences)
      .values({ userId: user.id, type: "digest_weekly", channelId: null, medium: "email", enabled: true });
  return user;
}

/** A followed channel with one public ready video and one clip made `ageMs` before `now`. */
async function followedWithContent(followerId: string, now: Date, ageMs = 86_400_000) {
  const { channel } = await makeUser(db());
  await db().insert(schema.follows).values({ followerId, channelId: channel.id, notify: true });
  const b = await makeBroadcast(db(), channel.id);
  const at = new Date(now.getTime() - ageMs);
  const [vod] = await db()
    .insert(schema.vods)
    .values({
      id: uuidv7(),
      broadcastId: b.id,
      channelId: channel.id,
      title: `Video of ${channel.slug}`,
      status: "ready",
      storagePrefix: `vods/${b.id}`,
      createdAt: at,
    })
    .returning();
  await db()
    .insert(schema.clips)
    .values({
      id: uuidv7(),
      channelId: channel.id,
      broadcastId: b.id,
      title: `Clip of ${channel.slug}`,
      startOffset: 0,
      durationSeconds: 10,
      status: "ready",
      createdAt: at,
    });
  return { channel, vod: vod! };
}

describe("the weekly digest", () => {
  let mailer: MemoryMailer;
  beforeEach(() => {
    mailer = new MemoryMailer({ site });
  });
  const mailsTo = (email: string) => mailer.sent.filter((m) => m.to === email && m.template === "weeklyDigest");

  test("registered hourly on the email queue, not retried", () => {
    expect(JOBS).toContain(weeklyJob);
    expect(weeklyJob.name).toBe(WEEKLY_DIGEST_JOB);
    expect(weeklyJob.schedule).toEqual({ pattern: "7 * * * *" });
    expect(weeklyJob.attempts).toBe(1);
    expect(weeklyJob.data.safeParse({}).success).toBe(true);
  });

  test("an opted-in, verified member gets the videos and clips of their follows, with tracked links and List-Unsubscribe", async () => {
    const now = sendTime();
    const m = await member();
    const { channel, vod } = await followedWithContent(m.id, now);
    const r = await runWeeklyDigest(context(mailer, now));
    expect(r).toMatchObject({ due: true, failed: 0 });
    const [mail] = mailsTo(m.email);
    expect(mail?.subject).toBe(`What you missed on ${site.name} this week`);
    expect(mail?.html).toContain(`href="http://air.example.test/${channel.slug}/vods/${vod.id}?src=digest"`);
    expect(mail?.text).toContain(`Clip of ${channel.slug}`);
    expect(mail?.html).not.toMatch(/<img[^>]+src="(?!http:\/\/air\.example\.test)/);
    const unsub = mail?.headers["List-Unsubscribe"] ?? "";
    expect(unsub).toContain("list=weekly");
    const token = decodeURIComponent(/token=([^&>]+)/.exec(unsub)?.[1] ?? "");
    expect(await verifyUnsubscribeToken(AUTH_SECRET, token, "weekly")).toBe(m.id);
    const claims = await db().select().from(sends).where(eq(sends.userId, m.id));
    expect(claims).toEqual([expect.objectContaining({ weekStart: weekStartOf(now) })]);
  });

  test("once per week: a second run, or a replica racing it, sends nothing more", async () => {
    const now = sendTime();
    const m = await member();
    await followedWithContent(m.id, now);
    await Promise.all([runWeeklyDigest(context(mailer, now)), runWeeklyDigest(context(mailer, now))]);
    await runWeeklyDigest(context(mailer, new Date(now.getTime() + 3_600_000)));
    expect(mailsTo(m.email)).toHaveLength(1);
    expect(await db().select().from(sends).where(eq(sends.userId, m.id))).toHaveLength(1);
  });

  test("a week with nothing new is skipped (claimed, no email)", async () => {
    const now = sendTime();
    const m = await member();
    // Content older than a week does not count.
    await followedWithContent(m.id, now, 8 * 86_400_000);
    const r = await runWeeklyDigest(context(mailer, now));
    expect(r.empty).toBeGreaterThanOrEqual(1);
    expect(mailsTo(m.email)).toHaveLength(0);
    expect(await db().select().from(sends).where(eq(sends.userId, m.id))).toHaveLength(1);
  });

  test("not opted in (the default), opted out by unsubscribe, or unverified: no email and no claim", async () => {
    const now = sendTime();
    const none = await member({ optIn: false });
    const unverified = await member({ verified: false });
    const unsubscribed = await member();
    await db()
      .update(schema.notificationPreferences)
      .set({ enabled: false })
      .where(
        and(
          eq(schema.notificationPreferences.userId, unsubscribed.id),
          eq(schema.notificationPreferences.type, "digest_weekly"),
        ),
      );
    for (const u of [none, unverified, unsubscribed]) await followedWithContent(u.id, now);
    await runWeeklyDigest(context(mailer, now));
    for (const u of [none, unverified, unsubscribed]) {
      expect(mailsTo(u.email)).toHaveLength(0);
      expect(await db().select().from(sends).where(eq(sends.userId, u.id))).toHaveLength(0);
    }
  });

  test("outside the send window nothing happens", async () => {
    const now = sendTime();
    const m = await member();
    await followedWithContent(m.id, now);
    const early = new Date(now.getTime() - (DIGEST_RULES.sendHourUtc * 60 + 10) * 60_000);
    const otherDay = new Date(now.getTime() + 86_400_000);
    for (const t of [early, otherDay]) expect((await runWeeklyDigest(context(mailer, t))).due).toBe(false);
    expect(mailsTo(m.email)).toHaveLength(0);
  });

  test("a failed send rolls the claim back so the next run tries again", async () => {
    const now = sendTime();
    const m = await member();
    await followedWithContent(m.id, now);
    const failing: Mailer = {
      send: async () => {
        throw new Error("smtp down");
      },
      close: async () => undefined,
    };
    const r = await runWeeklyDigest(context(failing, now));
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(sends).where(eq(sends.userId, m.id))).toHaveLength(0);
    await runWeeklyDigest(context(mailer, new Date(now.getTime() + 3_600_000)));
    expect(mailsTo(m.email)).toHaveLength(1);
  });
});

describe("weekStartOf", () => {
  test("the Monday of the ISO week, in UTC", () => {
    expect(weekStartOf(new Date("2026-11-09T00:00:00Z"))).toBe("2026-11-09");
    expect(weekStartOf(new Date("2026-11-15T23:59:59Z"))).toBe("2026-11-09");
    expect(weekStartOf(new Date("2026-11-16T09:00:00Z"))).toBe("2026-11-16");
  });
});

describe("the video-ready email", () => {
  test("registered every minute on the email queue", () => {
    expect(JOBS).toContain(vodJob);
    expect(vodJob.name).toBe(VOD_EMAIL_JOB);
    expect(vodJob.schedule).toEqual({ every: 60_000 });
  });

  async function readyRow(opts: { creatorEmail?: boolean; verified?: boolean; createdAt?: Date } = {}) {
    const { user, channel } = await makeUser(db());
    await db()
      .update(schema.users)
      .set({ emailVerified: opts.verified ?? true })
      .where(eq(schema.users.id, user.id));
    if (opts.creatorEmail !== undefined)
      await db()
        .insert(schema.notificationPreferences)
        .values({ userId: user.id, type: "creator", channelId: null, medium: "email", enabled: opts.creatorEmail });
    const b = await makeBroadcast(db(), channel.id);
    const [vod] = await db()
      .insert(schema.vods)
      .values({
        id: uuidv7(),
        broadcastId: b.id,
        channelId: channel.id,
        title: "My stream",
        status: "ready",
        storagePrefix: `vods/${b.id}`,
      })
      .returning();
    await db()
      .insert(schema.notifications)
      .values({
        userId: user.id,
        type: "vod_ready",
        payload: { vodId: vod!.id, broadcastId: b.id, slug: channel.slug, title: "My stream" },
        createdAt: opts.createdAt ?? new Date(),
      });
    return { user, channel, vod: vod! };
  }

  test("sent once to a creator who turned creator email on; never by default; never when unverified", async () => {
    const mailer = new MemoryMailer({ site });
    const on = await readyRow({ creatorEmail: true });
    const byDefault = await readyRow();
    const unverified = await readyRow({ creatorEmail: true, verified: false });
    const ctx = context(mailer, new Date());
    await sweepVodReadyEmails(ctx);
    await sweepVodReadyEmails(ctx);
    const mails = mailer.sent.filter((m) => m.template === "vodReady");
    expect(mails.map((m) => m.to)).toEqual([on.user.email]);
    expect(mails[0]?.subject).toBe("Your video is ready: My stream");
    expect(mails[0]?.html).toContain(`href="http://air.example.test/${on.channel.slug}/vods/${on.vod.id}"`);
    expect(mails[0]?.headers["List-Unsubscribe"]).toContain("list=creator");
    for (const u of [byDefault, unverified]) expect(mails.some((m) => m.to === u.user.email)).toBe(false);
  });

  test("rows older than the window are left alone", async () => {
    const mailer = new MemoryMailer({ site });
    const old = await readyRow({ creatorEmail: true, createdAt: new Date(Date.now() - VOD_EMAIL_WINDOW_MS - 60_000) });
    await sweepVodReadyEmails(context(mailer, new Date()));
    expect(mailer.sent.some((m) => m.to === old.user.email)).toBe(false);
  });
});
