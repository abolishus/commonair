// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.preferences.{get,set}` against Postgres (ADR 0028 decision 4; N1-inbox). */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { type Client, signUpAndSignIn, startApi, uniqueName, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const PATH = "/api/notifications/preferences";

interface Prefs {
  type: string;
  defaults: Record<"in_app" | "email" | "push", boolean>;
  builtIn: Record<"in_app" | "email" | "push", boolean>;
  channels: { channel: { id: string; slug: string; displayName: string }; media: Record<string, boolean> }[];
  emailVerified: boolean;
}

/** A channel owned by a user made straight in the database. */
async function newChannel(): Promise<{ id: string; slug: string }> {
  const name = uniqueName("ch");
  const [u] = await db()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name, emailVerified: true })
    .returning({ id: schema.users.id });
  const [c] = await db()
    .insert(schema.channels)
    .values({ ownerId: u!.id, slug: name, displayName: `Display ${name}` })
    .returning({ id: schema.channels.id });
  return { id: c!.id, slug: name };
}

async function follow(c: Client, slug: string): Promise<void> {
  const r = await c.call("PUT", `/api/channels/${slug}/follow`, { notify: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

const set = (c: Client, body: Record<string, unknown>) => c.call<Prefs>("PUT", PATH, { type: "go_live", ...body });

describe("notifications.preferences", () => {
  test("no rows: the built-in defaults, all marked built in", async () => {
    const me = await signUpAndSignIn(api);
    const r = await me.client.call<Prefs>("GET", PATH);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({
      type: "go_live",
      defaults: { in_app: true, email: false, push: false },
      builtIn: { in_app: true, email: true, push: true },
      channels: [],
      emailVerified: true,
    });
  });

  test("setting a default stores one row and is no longer built in; setting it again updates it", async () => {
    const me = await signUpAndSignIn(api);
    const on = await set(me.client, { medium: "email", channel: null, enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.defaults).toEqual({ in_app: true, email: true, push: false });
    expect(on.body.builtIn).toEqual({ in_app: true, email: false, push: true });

    const off = await set(me.client, { medium: "email", channel: null, enabled: false });
    expect(off.body.defaults.email).toBe(false);
    expect(off.body.builtIn.email).toBe(false);
    const rows = await db()
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, me.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelId: null, medium: "email", enabled: false, type: "go_live" });

    const got = await me.client.call<Prefs>("GET", PATH);
    expect(got.body).toEqual(off.body);
  });

  test("a channel override, then removing it", async () => {
    const me = await signUpAndSignIn(api);
    const ch = await newChannel();
    await follow(me.client, ch.slug);

    const on = await set(me.client, { medium: "push", channel: ch.slug, enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.channels).toEqual([
      { channel: { id: ch.id, slug: ch.slug, displayName: `Display ${ch.slug}` }, media: { push: true } },
    ]);
    // The default is untouched.
    expect(on.body.defaults.push).toBe(false);
    expect(on.body.builtIn.push).toBe(true);

    const both = await set(me.client, { medium: "email", channel: ch.slug, enabled: false });
    expect(both.body.channels[0]?.media).toEqual({ email: false, push: true });

    const removed = await set(me.client, { medium: "push", channel: ch.slug, enabled: null });
    expect(removed.status).toBe(200);
    expect(removed.body.channels[0]?.media).toEqual({ email: false });
    const gone = await set(me.client, { medium: "email", channel: ch.slug, enabled: null });
    expect(gone.body.channels).toEqual([]);
    // Removing an override that does not exist is fine.
    const again = await set(me.client, { medium: "email", channel: ch.slug, enabled: null });
    expect(again.status).toBe(200);
  });

  test("enabled null without a channel is BAD_REQUEST", async () => {
    const me = await signUpAndSignIn(api);
    const r = await set(me.client, { medium: "email", channel: null, enabled: null });
    expect(r.status).toBe(400);
  });

  test("a channel the member does not follow is BAD_REQUEST; an unknown slug is NOT_FOUND", async () => {
    const me = await signUpAndSignIn(api);
    const ch = await newChannel();
    const unfollowed = await set(me.client, { medium: "email", channel: ch.slug, enabled: true });
    expect(unfollowed.status).toBe(400);
    const unknown = await set(me.client, { medium: "email", channel: uniqueName("nope"), enabled: true });
    expect(unknown.status).toBe(404);
    const rows = await db()
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, me.userId));
    expect(rows).toEqual([]);
  });

  test("unfollowing hides the override from get; following again shows it", async () => {
    const me = await signUpAndSignIn(api);
    const ch = await newChannel();
    const other = await newChannel();
    await follow(me.client, ch.slug);
    await follow(me.client, other.slug);
    await set(me.client, { medium: "email", channel: ch.slug, enabled: true });
    await set(me.client, { medium: "email", channel: other.slug, enabled: false });

    const un = await me.client.call("DELETE", `/api/channels/${ch.slug}/follow`);
    expect(un.status).toBe(200);
    const after = await me.client.call<Prefs>("GET", PATH);
    expect(after.body.channels.map((c) => c.channel.slug)).toEqual([other.slug]);
    // The row stays (deleted with the channel or the account).
    const kept = await db()
      .select()
      .from(schema.notificationPreferences)
      .where(
        and(eq(schema.notificationPreferences.userId, me.userId), eq(schema.notificationPreferences.channelId, ch.id)),
      );
    expect(kept).toHaveLength(1);

    await follow(me.client, ch.slug);
    const back = await me.client.call<Prefs>("GET", PATH);
    expect(back.body.channels.map((c) => c.channel.slug).sort()).toEqual([ch.slug, other.slug].sort());
  });

  test("emailVerified follows the account", async () => {
    const me = await signUpAndSignIn(api);
    await db().update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, me.userId));
    const r = await me.client.call<Prefs>("GET", PATH);
    expect(r.body.emailVerified).toBe(false);
  });

  test("signed out: UNAUTHORIZED", async () => {
    const res = await fetch(`${api.url}${PATH}`);
    expect(res.status).toBe(401);
  });
});
