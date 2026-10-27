// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E7 appeals: an overturned moderation appeal lifts the ban or suspension it was about, account
 * actions (DMCA strikes and the repeat-infringer termination) are appealable and reversed once,
 * DMCA notices point to the counter-notice, and the appellant is emailed the decision.
 *
 * A suspended account cannot write through the API (`decideAccess`), so the appeals of a
 * suspension are inserted directly here (see the contract request in the E7-appeals report).
 */
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { appealRef, DMCA_APPEAL_MESSAGE } from "../src/routes/appeals.ts";
import { client, mailTo, signUpAndSignIn, startApi, subscriber, waitFor, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface AppealDto {
  id: string;
  status: string;
  subjectType: string;
}
interface AccountActionDto {
  id: string;
  action: string;
  reversedAt: string | null;
  reversedReason: string | null;
}

let api: TestApi;
let streamer: User;
let mod: User;
let mod2: User;
let channelId: string;
const BODY = "This decision was a mistake, please look at it again.";

const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  [streamer, mod, mod2] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, mod.userId));
  await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, mod2.userId));
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, streamer.userId));
  channelId = c!.id;
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

async function viewer(): Promise<User> {
  return signUpAndSignIn(api);
}

const appeal = (who: User, kind: string, subjectType: string, subjectId: string) =>
  who.client.call<AppealDto>("POST", "/api/appeals", { kind, subjectType, subjectId, body: BODY });

const resolve = (who: User, id: string, status: "upheld" | "overturned") =>
  who.client.call<AppealDto>("POST", `/api/admin/appeals/${id}`, { status, resolution: "Reviewed." });

/** An appeal row for an appellant who cannot write through the API (suspended). */
async function insertAppeal(
  appellantId: string,
  kind: "moderation" | "account",
  subjectType: string,
  subjectId: string,
) {
  const [a] = await db()
    .insert(schema.appeals)
    .values({ appellantId, kind, subjectType, subjectId, body: BODY })
    .returning();
  return a!;
}

async function banOf(userId: string) {
  const [u] = await db()
    .select({ banned: schema.users.banned, banReason: schema.users.banReason })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return u!;
}

async function latestModAction(targetUserId: string, action: (typeof schema.modActions.$inferSelect)["action"]) {
  const [m] = await db()
    .select()
    .from(schema.modActions)
    .where(and(eq(schema.modActions.targetUserId, targetUserId), eq(schema.modActions.action, action)))
    .orderBy(desc(schema.modActions.createdAt), desc(schema.modActions.id))
    .limit(1);
  return m;
}

async function auditOf(subjectId: string, action?: string) {
  const rows = await db().select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, subjectId));
  return action ? rows.filter((r) => r.action === action) : rows;
}

async function eventsOf(type: string) {
  return db().select().from(schema.events).where(eq(schema.events.type, type));
}

async function chanBan(target: User, durationSeconds?: number) {
  const res = await streamer.client.call("POST", `/api/channels/${streamer.username}/bans`, {
    username: target.username,
    ...(durationSeconds ? { durationSeconds } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const m = await latestModAction(target.userId, durationSeconds ? "timeout" : "ban");
  return m!;
}

async function activeBans(userId: string) {
  const rows = await db()
    .select()
    .from(schema.chatBans)
    .where(and(eq(schema.chatBans.channelId, channelId), eq(schema.chatBans.userId, userId)));
  return rows.filter((b) => b.liftedAt === null);
}

/** Collect messages on a pub/sub channel while `fn` runs. */
async function collecting(channel: string, fn: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const sub = subscriber();
  const got: Record<string, unknown>[] = [];
  await sub.subscribe(channel);
  sub.on("message", (_ch, msg) => got.push(JSON.parse(msg) as Record<string, unknown>));
  try {
    await fn();
    await Bun.sleep(150);
    return got;
  } finally {
    sub.disconnect();
  }
}

async function accountAction(
  userId: string,
  action: "dmca_strike" | "dmca_termination",
  createdAt = new Date(),
): Promise<string> {
  const [r] = await db()
    .insert(schema.accountActions)
    .values({
      userId,
      action,
      sourceType: "dmca_notice",
      sourceId: uuidv7(),
      actorType: "moderator",
      actorId: mod.userId,
      createdAt,
    })
    .returning({ id: schema.accountActions.id });
  return r!.id;
}

/** Three strikes and a termination with the repeat-infringer suspension, as E7-dmca records them. */
async function repeatInfringer(userId: string, suspension: "dmca_repeat_infringer" | "moderation") {
  const strikes = [await accountAction(userId, "dmca_strike"), await accountAction(userId, "dmca_strike")];
  strikes.push(await accountAction(userId, "dmca_strike"));
  const termination = await accountAction(userId, "dmca_termination");
  await db().update(schema.users).set({ banned: true, banReason: suspension }).where(eq(schema.users.id, userId));
  return { strikes, termination };
}

async function accountRow(id: string) {
  const [r] = await db().select().from(schema.accountActions).where(eq(schema.accountActions.id, id));
  return r!;
}

describe("overturned moderation_action appeals", () => {
  test("a channel ban is lifted: unban mod action, audit with appealId, channel.unban, control, email", async () => {
    const v = await viewer();
    const ban = await chanBan(v);
    const created = await appeal(v, "moderation", "moderation_action", ban.id);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    // The banning streamer is not a platform moderator; the appeal goes to someone else anyway.
    expect((await resolve(streamer, created.body.id, "overturned")).status).toBe(403);
    const unbansBefore = (await eventsOf("channel.unban")).length;
    let resolved: { status: number; body: AppealDto } | null = null;
    const control = await collecting(BUS.chatControl(channelId), async () => {
      resolved = await resolve(mod, created.body.id, "overturned");
    });
    expect(resolved!.status, JSON.stringify(resolved!.body)).toBe(200);
    expect(resolved!.body.status).toBe("overturned");

    expect(await activeBans(v.userId)).toEqual([]);
    const unban = await latestModAction(v.userId, "unban");
    expect(unban).toMatchObject({ moderatorId: mod.userId, channelId, scope: "channel" });
    const [chatUnban] = await auditOf(v.userId, "chat.unban");
    expect(chatUnban).toMatchObject({ actorId: mod.userId, actorType: "moderator", channelId });
    expect(chatUnban!.details).toMatchObject({ appealId: created.body.id });
    expect((await eventsOf("channel.unban")).length).toBe(unbansBefore + 1);
    expect(control).toContainEqual({ op: "invalidate", scope: "user", userId: v.userId });
    const [resolveAudit] = await auditOf(created.body.id, "appeal.resolve");
    expect(resolveAudit!.details).toMatchObject({ status: "overturned", effect: "chat_ban", lifted: true });

    const mail = await waitFor(async () => {
      const m = await mailTo(v.email);
      return m?.subject.includes(appealRef(created.body.id)) ? m : null;
    });
    expect(mail.text).toContain("/settings/appeals");
  });

  test("a timeout is lifted with an untimeout", async () => {
    const v = await viewer();
    const timeout = await chanBan(v, 3600);
    const created = await appeal(v, "moderation", "moderation_action", timeout.id);
    expect((await resolve(mod, created.body.id, "overturned")).status).toBe(200);
    expect(await activeBans(v.userId)).toEqual([]);
    expect(await latestModAction(v.userId, "untimeout")).toMatchObject({ moderatorId: mod.userId });
    const [a] = await auditOf(v.userId, "chat.untimeout");
    expect(a!.details).toMatchObject({ appealId: created.body.id });
  });

  test("a ban already lifted is left alone and recorded as not lifted", async () => {
    const v = await viewer();
    const ban = await chanBan(v);
    expect((await streamer.client.call("DELETE", `/api/channels/${streamer.username}/bans/${v.username}`)).status).toBe(
      200,
    );
    const created = await appeal(v, "moderation", "moderation_action", ban.id);
    expect((await resolve(mod, created.body.id, "overturned")).status).toBe(200);
    const unbans = await db()
      .select()
      .from(schema.modActions)
      .where(and(eq(schema.modActions.targetUserId, v.userId), eq(schema.modActions.action, "unban")));
    expect(unbans).toHaveLength(1);
    expect(unbans[0]!.moderatorId).toBe(streamer.userId);
    const [r] = await auditOf(created.body.id, "appeal.resolve");
    expect(r!.details).toMatchObject({ effect: "chat_ban", lifted: false });
  });

  test("a later ban supersedes the appealed one: it stays in force", async () => {
    const v = await viewer();
    const first = await chanBan(v, 60);
    const second = await chanBan(v);
    expect(second.id).not.toBe(first.id);
    const created = await appeal(v, "moderation", "moderation_action", first.id);
    expect((await resolve(mod, created.body.id, "overturned")).status).toBe(200);
    expect((await activeBans(v.userId)).length).toBeGreaterThan(0);
  });

  test("upheld changes nothing", async () => {
    const v = await viewer();
    const ban = await chanBan(v);
    const created = await appeal(v, "moderation", "moderation_action", ban.id);
    const res = await resolve(mod, created.body.id, "upheld");
    expect(res.body.status).toBe("upheld");
    expect(await activeBans(v.userId)).toHaveLength(1);
    expect(await latestModAction(v.userId, "unban")).toBeUndefined();
    const [r] = await auditOf(created.body.id, "appeal.resolve");
    expect(r!.details).not.toHaveProperty("lifted");
  });

  test("a platform user suspension is lifted as safety.suspend lifts it", async () => {
    const v = await viewer();
    const s = await mod.client.call("POST", `/api/admin/users/${v.username}/suspension`, {
      target: "user",
      suspended: true,
      reason: "Spam",
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    // A suspended account cannot write, so it cannot file the appeal itself today.
    expect((await appeal(v, "moderation", "moderation_action", uuidv7())).status).toBe(403);
    const suspend = await latestModAction(v.userId, "suspend_user");
    const a = await insertAppeal(v.userId, "moderation", "moderation_action", suspend!.id);
    // The moderator who suspended cannot resolve its appeal.
    expect((await resolve(mod, a.id, "overturned")).status).toBe(403);
    let res: { status: number; body: AppealDto } | null = null;
    const control = await collecting(BUS.userControl, async () => {
      res = await resolve(mod2, a.id, "overturned");
    });
    expect(res!.status, JSON.stringify(res!.body)).toBe(200);
    expect(await banOf(v.userId)).toEqual({ banned: false, banReason: null });
    expect(await latestModAction(v.userId, "unsuspend_user")).toMatchObject({ moderatorId: mod2.userId });
    const [u] = await auditOf(v.userId, "user.unsuspend");
    expect(u).toMatchObject({ actorId: mod2.userId });
    expect(u!.details).toMatchObject({ appealId: a.id });
    expect(control).toContainEqual({ op: "invalidate", userId: v.userId, reason: "suspended" });
    // The account can write again.
    expect(
      (
        await v.client.call("POST", "/api/appeals", {
          kind: "integrity",
          subjectType: "user",
          subjectId: v.userId,
          body: BODY,
        })
      ).status,
    ).toBe(200);
  });

  test("a T0 suspension refuses the overturn and nothing changes", async () => {
    const v = await viewer();
    const [m] = await db()
      .insert(schema.modActions)
      .values({ scope: "platform", moderatorId: mod.userId, targetUserId: v.userId, action: "suspend_user" })
      .returning();
    await db().insert(schema.moderationCases).values({
      tier: "t0",
      origin: "hash_list",
      subjectType: "broadcast",
      subjectId: uuidv7(),
      userId: v.userId,
      listCategory: "csam",
      priority: 1000,
    });
    await db()
      .update(schema.users)
      .set({ banned: true, banReason: "t0_hash_match" })
      .where(eq(schema.users.id, v.userId));
    const a = await insertAppeal(v.userId, "moderation", "moderation_action", m!.id);
    const res = await resolve(mod2, a.id, "overturned");
    expect(res.status).toBe(403);
    expect(await banOf(v.userId)).toEqual({ banned: true, banReason: "t0_hash_match" });
    const [after] = await db().select().from(schema.appeals).where(eq(schema.appeals.id, a.id));
    expect(after!.status).toBe("open");
    expect(await auditOf(a.id)).toEqual([]);
    expect(await latestModAction(v.userId, "unsuspend_user")).toBeUndefined();
  });

  test("a suspend_user overturn leaves a repeat-infringer (DMCA) suspension in place", async () => {
    const v = await viewer();
    const [m] = await db()
      .insert(schema.modActions)
      .values({ scope: "platform", moderatorId: mod.userId, targetUserId: v.userId, action: "suspend_user" })
      .returning();
    await db()
      .update(schema.users)
      .set({ banned: true, banReason: "dmca_repeat_infringer" })
      .where(eq(schema.users.id, v.userId));
    const a = await insertAppeal(v.userId, "moderation", "moderation_action", m!.id);
    expect((await resolve(mod2, a.id, "overturned")).status).toBe(200);
    expect(await banOf(v.userId)).toEqual({ banned: true, banReason: "dmca_repeat_infringer" });
    const [r] = await auditOf(a.id, "appeal.resolve");
    expect(r!.details).toMatchObject({ effect: "suspension", lifted: false });
  });

  test("an expired timeout is left alone: its row is not stamped lifted by the resolver", async () => {
    const v = await viewer();
    const timeout = await chanBan(v, 60);
    await db()
      .update(schema.chatBans)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(schema.chatBans.channelId, channelId), eq(schema.chatBans.userId, v.userId)));
    const created = await appeal(v, "moderation", "moderation_action", timeout.id);
    expect((await resolve(mod, created.body.id, "overturned")).status).toBe(200);
    const rows = await activeBans(v.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.liftedBy).toBeNull();
    expect(await latestModAction(v.userId, "untimeout")).toBeUndefined();
    const [r] = await auditOf(created.body.id, "appeal.resolve");
    expect(r!.details).toMatchObject({ effect: "chat_ban", lifted: false });
  });

  test("a timed suspension past its end is not lifted again", async () => {
    const v = await viewer();
    const [m] = await db()
      .insert(schema.modActions)
      .values({ scope: "platform", moderatorId: mod.userId, targetUserId: v.userId, action: "suspend_user" })
      .returning();
    await db()
      .update(schema.users)
      .set({ banned: true, banReason: "moderation", banExpires: new Date(Date.now() - 1000) })
      .where(eq(schema.users.id, v.userId));
    const a = await insertAppeal(v.userId, "moderation", "moderation_action", m!.id);
    expect((await resolve(mod2, a.id, "overturned")).status).toBe(200);
    expect(await latestModAction(v.userId, "unsuspend_user")).toBeUndefined();
    expect(await auditOf(v.userId, "user.unsuspend")).toEqual([]);
    const [r] = await auditOf(a.id, "appeal.resolve");
    expect(r!.details).toMatchObject({ effect: "suspension", lifted: false });
  });

  test("a moderation suspension over an unreversed DMCA termination hands back the DMCA suspension", async () => {
    const v = await viewer();
    const { termination } = await repeatInfringer(v.userId, "dmca_repeat_infringer");
    // `safety.suspend` overwrites the repeat-infringer reason with `moderation`.
    const s = await mod.client.call("POST", `/api/admin/users/${v.username}/suspension`, {
      target: "user",
      suspended: true,
      durationSeconds: 3600,
      reason: "Spam",
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(await banOf(v.userId)).toEqual({ banned: true, banReason: "moderation" });
    const suspend = await latestModAction(v.userId, "suspend_user");
    const a = await insertAppeal(v.userId, "moderation", "moderation_action", suspend!.id);
    expect((await resolve(mod2, a.id, "overturned")).status).toBe(200);
    const [u] = await db()
      .select({ banned: schema.users.banned, banReason: schema.users.banReason, banExpires: schema.users.banExpires })
      .from(schema.users)
      .where(eq(schema.users.id, v.userId));
    expect(u).toEqual({ banned: true, banReason: "dmca_repeat_infringer", banExpires: null });
    expect((await accountRow(termination)).reversedAt).toBeNull();
    expect(await latestModAction(v.userId, "unsuspend_user")).toBeUndefined();
    const [r] = await auditOf(a.id, "appeal.resolve");
    expect(r!.details).toMatchObject({ effect: "suspension", lifted: false, dmcaSuspensionRestored: true });
  });

  test("a channel suspension is lifted as safety.suspend lifts it", async () => {
    const v = await viewer();
    const [ch] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, v.userId));
    const s = await mod.client.call("POST", `/api/admin/users/${v.username}/suspension`, {
      target: "channel",
      suspended: true,
      reason: "Spam",
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const suspend = await latestModAction(v.userId, "suspend_channel");
    const a = await insertAppeal(v.userId, "moderation", "moderation_action", suspend!.id);
    expect((await resolve(mod2, a.id, "overturned")).status).toBe(200);
    const [after] = await db()
      .select({ at: schema.channels.suspendedAt, reason: schema.channels.suspendedReason })
      .from(schema.channels)
      .where(eq(schema.channels.id, ch!.id));
    expect(after).toEqual({ at: null, reason: null });
    expect(await latestModAction(v.userId, "unsuspend_channel")).toMatchObject({
      moderatorId: mod2.userId,
      channelId: ch!.id,
    });
    const [audit] = await auditOf(ch!.id, "channel.unsuspend");
    expect(audit).toMatchObject({ actorId: mod2.userId });
    expect(audit!.details).toMatchObject({ appealId: a.id });
    const [r] = await auditOf(a.id, "appeal.resolve");
    expect(r!.details).toMatchObject({ effect: "suspension", lifted: true });
  });

  test("an action with nothing to undo is recorded only", async () => {
    const v = await viewer();
    const [m] = await db()
      .insert(schema.modActions)
      .values({ scope: "channel", channelId, moderatorId: streamer.userId, targetUserId: v.userId, action: "warn" })
      .returning();
    const created = await appeal(v, "moderation", "moderation_action", m!.id);
    expect((await resolve(mod, created.body.id, "overturned")).status).toBe(200);
    const [r] = await auditOf(created.body.id, "appeal.resolve");
    expect(r!.details).toMatchObject({ effect: "recorded_only", lifted: false });
    expect(await auditOf(v.userId, "chat.unban")).toEqual([]);
  });
});

describe("account appeals", () => {
  test("create: someone else's action is missing, a reversed one conflicts", async () => {
    const [u, other] = await Promise.all([viewer(), viewer()]);
    const strike = await accountAction(u.userId, "dmca_strike");
    expect((await appeal(other, "account", "account_action", strike)).status).toBe(404);
    expect((await appeal(u, "moderation", "account_action", strike)).status).toBe(400);
    const reversed = await accountAction(u.userId, "dmca_strike");
    await db()
      .update(schema.accountActions)
      .set({ reversedAt: new Date(), reversedReason: "counter_notice_restored" })
      .where(eq(schema.accountActions.id, reversed));
    expect((await appeal(u, "account", "account_action", reversed)).status).toBe(409);
    const ok = await appeal(u, "account", "account_action", strike);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // One open appeal per subject.
    expect((await appeal(u, "account", "account_action", strike)).status).toBe(409);
  });

  test("overturning reverses the action once; the trigger refuses a second reversal", async () => {
    const u = await viewer();
    const strike = await accountAction(u.userId, "dmca_strike");
    const created = await appeal(u, "account", "account_action", strike);
    // The moderator who recorded it does not review it.
    expect((await resolve(mod, created.body.id, "overturned")).status).toBe(403);
    expect((await resolve(mod2, created.body.id, "overturned")).status).toBe(200);
    const row = await accountRow(strike);
    expect(row).toMatchObject({
      reversedById: mod2.userId,
      reversedReason: "appeal_overturned",
      reversalAppealId: created.body.id,
    });
    expect(row.reversedAt).not.toBeNull();
    const events = (await eventsOf("account.action.reversed")).filter((e) => e.payload.account_action_id === strike);
    expect(events.map((e) => e.payload)).toEqual([
      { account_action_id: strike, user_id: u.userId, action: "dmca_strike", reversal: "appeal_overturned" },
    ]);
    const [a] = await auditOf(strike, "account.action.reverse");
    expect(a).toMatchObject({ actorId: mod2.userId });
    expect(a!.details).toMatchObject({ appealId: created.body.id, reversal: "appeal_overturned" });
    await expect(
      api.db.app.db
        .update(schema.accountActions)
        .set({ reversedAt: new Date(), reversedReason: "strikes_below_threshold" })
        .where(eq(schema.accountActions.id, strike)),
    ).rejects.toThrow(/Failed query/);
  });

  test("overturning a termination lifts the repeat-infringer suspension", async () => {
    const u = await viewer();
    const { strikes, termination } = await repeatInfringer(u.userId, "dmca_repeat_infringer");
    const a = await insertAppeal(u.userId, "account", "account_action", termination);
    let res: { status: number } | null = null;
    const control = await collecting(BUS.userControl, async () => {
      res = await resolve(mod2, a.id, "overturned");
    });
    expect(res!.status).toBe(200);
    expect(await banOf(u.userId)).toEqual({ banned: false, banReason: null });
    expect((await accountRow(termination)).reversedReason).toBe("appeal_overturned");
    for (const s of strikes) expect((await accountRow(s)).reversedAt).toBeNull();
    expect(control).toContainEqual({ op: "invalidate", userId: u.userId, reason: "suspended" });
  });

  test("a strike overturn under the threshold also reverses the termination", async () => {
    const u = await viewer();
    const { strikes, termination } = await repeatInfringer(u.userId, "dmca_repeat_infringer");
    const a = await insertAppeal(u.userId, "account", "account_action", strikes[0]!);
    expect((await resolve(mod2, a.id, "overturned")).status).toBe(200);
    expect((await accountRow(strikes[0]!)).reversedReason).toBe("appeal_overturned");
    const t = await accountRow(termination);
    expect(t.reversedReason).toBe("strikes_below_threshold");
    expect(t.reversedById).toBe(mod2.userId);
    expect(await banOf(u.userId)).toEqual({ banned: false, banReason: null });
    const reversals = (await eventsOf("account.action.reversed")).filter((e) => e.payload.user_id === u.userId);
    expect(reversals.map((e) => String(e.payload.reversal)).sort((a, b) => a.localeCompare(b))).toEqual([
      "appeal_overturned",
      "strikes_below_threshold",
    ]);
    expect((await auditOf(termination, "account.action.reverse")).length).toBe(1);
    const [r] = await auditOf(a.id, "appeal.resolve");
    expect(r!.details).toMatchObject({ reversed: true, unsuspended: true, terminationReversed: termination });
  });

  test("a moderation suspension survives a termination overturn and a strike overturn", async () => {
    const u = await viewer();
    const one = await repeatInfringer(u.userId, "moderation");
    const a = await insertAppeal(u.userId, "account", "account_action", one.termination);
    expect((await resolve(mod2, a.id, "overturned")).status).toBe(200);
    expect((await accountRow(one.termination)).reversedAt).not.toBeNull();
    expect(await banOf(u.userId)).toEqual({ banned: true, banReason: "moderation" });

    const w = await viewer();
    const two = await repeatInfringer(w.userId, "moderation");
    const b = await insertAppeal(w.userId, "account", "account_action", two.strikes[1]!);
    expect((await resolve(mod2, b.id, "overturned")).status).toBe(200);
    expect((await accountRow(two.termination)).reversedReason).toBe("strikes_below_threshold");
    expect(await banOf(w.userId)).toEqual({ banned: true, banReason: "moderation" });
  });

  test("an action reversed after the appeal was filed resolves without a second reversal", async () => {
    const u = await viewer();
    const strike = await accountAction(u.userId, "dmca_strike");
    const created = await appeal(u, "account", "account_action", strike);
    await db()
      .update(schema.accountActions)
      .set({ reversedAt: new Date(), reversedReason: "counter_notice_restored" })
      .where(eq(schema.accountActions.id, strike));
    expect((await resolve(mod2, created.body.id, "overturned")).status).toBe(200);
    expect((await accountRow(strike)).reversedReason).toBe("counter_notice_restored");
    const [r] = await auditOf(created.body.id, "appeal.resolve");
    expect(r!.details).toMatchObject({ reversed: false });
  });

  test("accountActions lists only the caller's, newest first", async () => {
    const [u, other] = await Promise.all([viewer(), viewer()]);
    const older = await accountAction(u.userId, "dmca_strike", new Date(Date.now() - 60_000));
    const newer = await accountAction(u.userId, "dmca_termination");
    await accountAction(other.userId, "dmca_strike");
    const res = await u.client.call<AccountActionDto[]>("GET", "/api/appeals/account-actions");
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id)).toEqual([newer, older]);
    expect(res.body[0]).toMatchObject({ action: "dmca_termination", reversedAt: null, reversedReason: null });
    expect((await client(api).call("GET", "/api/appeals/account-actions")).status).toBe(401);
  });
});

describe("dmca appeals", () => {
  test("the owner is sent to the counter-notice; anyone else gets not-found", async () => {
    const [owner, other] = await Promise.all([viewer(), viewer()]);
    const [n] = await db()
      .insert(schema.dmcaNotices)
      .values({
        claimantName: "Claimant",
        claimantEmail: "claimant@test.invalid",
        claimantAddress: "1 Street",
        copyrightedWork: "A song",
        infringingUrls: ["https://example.test/x"],
        goodFaithStatement: true,
        accuracyStatement: true,
        signature: "Claimant",
      })
      .returning();
    await db().insert(schema.dmcaNoticeItems).values({
      noticeId: n!.id,
      url: "https://example.test/x",
      subjectType: "clip",
      subjectId: uuidv7(),
      ownerId: owner.userId,
    });
    const mine = await appeal(owner, "dmca", "dmca_notice", n!.id);
    expect(mine.status).toBe(400);
    expect(JSON.stringify(mine.body)).toContain("/settings/copyright");
    expect(JSON.stringify(mine.body)).toContain(DMCA_APPEAL_MESSAGE.slice(0, 40));
    expect((await appeal(other, "dmca", "dmca_notice", n!.id)).status).toBe(404);
    expect(await db().select().from(schema.appeals).where(eq(schema.appeals.subjectId, n!.id))).toEqual([]);
  });
});
