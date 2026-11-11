// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 4, D7.3 (d7-notify): preferences for every type, the payout, creator and weekly
 * unsubscribe lists, digest consent records, and `me.notifications` (types filter, go-live faces,
 * in-app preferences applied at read time), against real Postgres and Valkey.
 */
import { NOTIFY_DEFAULTS, EMAIL_UNSUBSCRIBE_PATH } from "@commonair/contracts/notify";
import { PREFERENCE_MEDIA, PREFERENCE_TYPES, NOTIFY_MEDIA } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import { signUnsubscribeToken } from "@commonair/tokens";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { DIGEST_CONSENT_POLICY } from "../src/notifications/preferences/consent.ts";
import { signUpAndSignIn, startApi, uniqueName, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const np = schema.notificationPreferences;
const PATH = "/api/notifications/preferences";

interface Prefs {
  type: string;
  defaults: Record<"in_app" | "email" | "push", boolean>;
  builtIn: Record<"in_app" | "email" | "push", boolean>;
  channels: unknown[];
  emailVerified: boolean;
}

interface Item {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

async function newChannel(): Promise<{ id: string; slug: string; ownerId: string }> {
  const name = uniqueName("dn");
  const [u] = await db()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name, emailVerified: true, image: "avatars/a.png" })
    .returning({ id: schema.users.id });
  const [c] = await db()
    .insert(schema.channels)
    .values({ ownerId: u!.id, slug: name, displayName: `Display ${name}` })
    .returning({ id: schema.channels.id });
  return { id: c!.id, slug: name, ownerId: u!.id };
}

describe("notifications.preferences for every type", () => {
  test("get answers the built-in defaults of each type", async () => {
    const me = await signUpAndSignIn(api);
    for (const type of PREFERENCE_TYPES) {
      const r = await me.client.call<Prefs>("GET", `${PATH}?type=${type}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ type, defaults: NOTIFY_DEFAULTS[type], channels: [] });
    }
  });

  test("set accepts every offered medium and refuses the others with BAD_REQUEST", async () => {
    const me = await signUpAndSignIn(api);
    const answers: { key: string; status: number; on: boolean | undefined }[] = [];
    const wanted: { key: string; status: number; on: boolean | undefined }[] = [];
    for (const type of PREFERENCE_TYPES)
      for (const medium of NOTIFY_MEDIA) {
        const r = await me.client.call<Prefs>("PUT", PATH, { type, medium, channel: null, enabled: true });
        const offered = PREFERENCE_MEDIA[type].includes(medium);
        answers.push({ key: `${type}/${medium}`, status: r.status, on: offered ? r.body.defaults[medium] : undefined });
        wanted.push({ key: `${type}/${medium}`, status: offered ? 200 : 400, on: offered ? true : undefined });
      }
    expect(answers).toEqual(wanted);
    const stored = await db().select({ type: np.type, medium: np.medium }).from(np).where(eq(np.userId, me.userId));
    const offered = PREFERENCE_TYPES.reduce((n, t) => n + PREFERENCE_MEDIA[t].length, 0);
    expect(stored).toHaveLength(offered);
  });

  test("wave 5: governance email is offered (off by default); payout in-app is not a choice", async () => {
    const me = await signUpAndSignIn(api);
    const get = await me.client.call<Prefs>("GET", `${PATH}?type=governance`);
    expect(get.body.defaults.email).toBe(false);
    const on = await me.client.call<Prefs>("PUT", PATH, {
      type: "governance",
      medium: "email",
      channel: null,
      enabled: true,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ type: "governance", defaults: { email: true }, builtIn: { email: false } });
    const payout = await me.client.call("PUT", PATH, {
      type: "payout",
      medium: "in_app",
      channel: null,
      enabled: false,
    });
    expect(payout.status).toBe(400);
    const stored = await db()
      .select({ type: np.type, medium: np.medium, enabled: np.enabled })
      .from(np)
      .where(eq(np.userId, me.userId));
    expect(stored).toEqual([{ type: "governance", medium: "email", enabled: true }]);
  });

  test("only go-live is set per channel", async () => {
    const me = await signUpAndSignIn(api);
    const ch = await newChannel();
    await me.client.call("PUT", `/api/channels/${ch.slug}/follow`, { notify: true });
    const r = await me.client.call("PUT", PATH, { type: "creator", medium: "email", channel: ch.slug, enabled: true });
    expect(r.status).toBe(400);
  });

  test("each digest choice is kept as a consent record; other types write none", async () => {
    const me = await signUpAndSignIn(api);
    const put = (type: string, enabled: boolean) =>
      me.client.call("PUT", PATH, { type, medium: "email", channel: null, enabled });
    expect((await put("digest_weekly", true)).status).toBe(200);
    expect((await put("digest_weekly", false)).status).toBe(200);
    expect((await put("payout", false)).status).toBe(200);
    const records = await db()
      .select({ choices: schema.consentRecords.choices, policyVersion: schema.consentRecords.policyVersion })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, me.userId))
      .orderBy(schema.consentRecords.createdAt, schema.consentRecords.id);
    expect(records).toEqual([
      { choices: { digestWeekly: true, via_settings: true }, policyVersion: DIGEST_CONSENT_POLICY },
      { choices: { digestWeekly: false, via_settings: true }, policyVersion: DIGEST_CONSENT_POLICY },
    ]);
  });

  test("turning the digest on records the first opt-in (0058 trigger)", async () => {
    const me = await signUpAndSignIn(api);
    await me.client.call("PUT", PATH, { type: "digest_weekly", medium: "email", channel: null, enabled: true });
    const [u] = await db()
      .select({ at: schema.users.firstNotifyOptinAt })
      .from(schema.users)
      .where(eq(schema.users.id, me.userId));
    expect(u?.at).toBeInstanceOf(Date);
  });
});

describe("one-click unsubscribe for the payout, creator and weekly lists", () => {
  const oneClick = async (list: "payout" | "creator" | "weekly", userId: string) =>
    fetch(
      `${api.url}${EMAIL_UNSUBSCRIBE_PATH}?${new URLSearchParams({
        list,
        token: await signUnsubscribeToken(api.deps.env.AUTH_SECRET, userId, list),
      }).toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
    );

  for (const [list, type] of [
    ["payout", "payout"],
    ["creator", "creator"],
    ["weekly", "digest_weekly"],
  ] as const)
    test(`${list}: email off for ${type}, nothing else touched`, async () => {
      const me = await signUpAndSignIn(api);
      await db()
        .insert(np)
        .values([
          { userId: me.userId, type, channelId: null, medium: "email", enabled: true },
          { userId: me.userId, type: "go_live", channelId: null, medium: "email", enabled: true },
        ]);
      expect((await oneClick(list, me.userId)).status).toBe(200);
      const rows = await db()
        .select({ type: np.type, enabled: np.enabled })
        .from(np)
        .where(and(eq(np.userId, me.userId), eq(np.medium, "email")));
      expect(rows.find((r) => r.type === type)?.enabled).toBe(false);
      expect(rows.find((r) => r.type === "go_live")?.enabled).toBe(true);
      // The settings page shows the result.
      const got = await me.client.call<Prefs>("GET", `${PATH}?type=${type}`);
      expect(got.body.defaults.email).toBe(false);
    });

  test("weekly records the withdrawal as a consent record", async () => {
    const me = await signUpAndSignIn(api);
    expect((await oneClick("weekly", me.userId)).status).toBe(200);
    const records = await db()
      .select({ choices: schema.consentRecords.choices })
      .from(schema.consentRecords)
      .where(
        and(
          eq(schema.consentRecords.userId, me.userId),
          eq(schema.consentRecords.policyVersion, DIGEST_CONSENT_POLICY),
        ),
      );
    expect(records).toEqual([{ choices: { digestWeekly: false, via_unsubscribe: true } }]);
  });
});

describe("me.notifications", () => {
  async function seed(userId: string, ch: { id: string; slug: string }) {
    const base = Date.now();
    await db()
      .insert(schema.notifications)
      .values([
        {
          userId,
          type: "go_live",
          payload: { channelId: ch.id, slug: ch.slug, broadcastId: ch.id, title: "Live now" },
          createdAt: new Date(base - 1000),
        },
        {
          userId,
          // A governance row the vote-open delivery rule leaves alone (it needs no voting proposal).
          type: "proposal",
          payload: { proposalId: ch.id, kind: "ordinary" },
          createdAt: new Date(base - 2000),
        },
        {
          userId,
          type: "vod_ready",
          payload: { vodId: ch.id, broadcastId: ch.id, slug: ch.slug, title: "Video" },
          createdAt: new Date(base - 3000),
        },
        {
          userId,
          type: "report_outcome",
          payload: { reportId: ch.id, subjectType: "message", outcome: "no_action" },
          createdAt: new Date(base - 4000),
        },
      ]);
  }

  test("go-live rows carry the channel's display name and avatar, joined at read time", async () => {
    const me = await signUpAndSignIn(api);
    const ch = await newChannel();
    await seed(me.userId, ch);
    const r = await me.client.call<{ items: Item[] }>("GET", "/api/me/notifications");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const live = r.body.items.find((i) => i.type === "go_live");
    expect(live?.payload).toMatchObject({ slug: ch.slug, displayName: `Display ${ch.slug}` });
    expect(typeof live?.payload.avatarUrl).toBe("string");
    // Never stored.
    const [row] = await db()
      .select({ payload: schema.notifications.payload })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, me.userId), eq(schema.notifications.type, "go_live")));
    expect(row?.payload).not.toHaveProperty("displayName");
    // A renamed channel shows its new name.
    await db().update(schema.channels).set({ displayName: "Renamed" }).where(eq(schema.channels.id, ch.id));
    const again = await me.client.call<{ items: Item[] }>("GET", "/api/me/notifications");
    expect(again.body.items.find((i) => i.type === "go_live")?.payload.displayName).toBe("Renamed");
  });

  test("the types filter answers only those types", async () => {
    const me = await signUpAndSignIn(api);
    await seed(me.userId, await newChannel());
    const r = await me.client.call<{ items: Item[] }>(
      "GET",
      "/api/me/notifications?types=proposal&types=report_outcome",
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.map((i) => i.type).sort()).toEqual(["proposal", "report_outcome"]);
    const one = await me.client.call<{ items: Item[] }>("GET", "/api/me/notifications?types[]=go_live");
    expect(one.body.items.map((i) => i.type)).toEqual(["go_live"]);
  });

  test("governance and creator in-app off hide their rows from the list and the badge; on again shows them", async () => {
    const me = await signUpAndSignIn(api);
    await seed(me.userId, await newChannel());
    const types = async () =>
      (await me.client.call<{ items: Item[] }>("GET", "/api/me/notifications")).body.items.map((i) => i.type).sort();
    const unread = async () =>
      (await me.client.call<{ count: number }>("GET", "/api/notifications/unread-count")).body.count;
    expect(await types()).toEqual(["go_live", "proposal", "report_outcome", "vod_ready"]);
    expect(await unread()).toBe(4);
    for (const type of ["governance", "creator"])
      await me.client.call("PUT", PATH, { type, medium: "in_app", channel: null, enabled: false });
    expect(await types()).toEqual(["go_live", "report_outcome"]);
    expect(await unread()).toBe(2);
    await me.client.call("PUT", PATH, { type: "governance", medium: "in_app", channel: null, enabled: true });
    expect(await types()).toEqual(["go_live", "proposal", "report_outcome"]);
  });
});
