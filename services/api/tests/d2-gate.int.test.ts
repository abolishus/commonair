// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d2-gate: sign-up intent, the `account.created` outbox row and `users.usernameAvailable`. */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { recordAccountCreated } from "../src/auth/index.ts";
import { client, signUpAndSignIn, solveAltcha, startApi, uniqueName, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

const signUp = async (username: string, extra: Record<string, unknown>) =>
  client(api).call("POST", "/api/auth/sign-up/email", {
    email: `${username}@test.invalid`,
    password: `pw-${crypto.randomUUID()}`,
    name: username,
    username,
    birthDate: "1990-01-01",
    altcha: await solveAltcha(api),
    ...extra,
  });

const userRow = async (username: string) =>
  (await api.db.db.select().from(schema.users).where(eq(schema.users.username, username)))[0];

const createdEvents = (userId: string) =>
  api.db.db
    .select({ payload: schema.events.payload, channelId: schema.events.channelId })
    .from(schema.events)
    .where(and(eq(schema.events.type, "account.created"), sql`${schema.events.payload}->>'user_id' = ${userId}`));

describe("sign-up intent", () => {
  test("a valid intent is stored and the account.created row carries it", async () => {
    const u = uniqueName();
    const res = await signUp(u, { signupIntent: "follow" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const user = await userRow(u);
    expect(user?.signupIntent).toBe("follow");
    const events = await createdEvents(user?.id ?? "");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ user_id: user?.id, intent: "follow" });
    expect(events[0]?.channelId).toBeNull();
    // The response never echoes it.
    expect(JSON.stringify(res.body)).not.toContain("signupIntent");
  });

  test.each([["vote"], ["report"], ["FOLLOW"], [""], [42], [{ x: 1 }]])(
    "invalid intent %j is stored as null",
    async (bad) => {
      const u = uniqueName();
      const res = await signUp(u, { signupIntent: bad });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const user = await userRow(u);
      expect(user?.signupIntent).toBeNull();
      expect((await createdEvents(user?.id ?? ""))[0]?.payload).toEqual({ user_id: user?.id, intent: null });
    },
  );

  test("no intent: null, and still one account.created row", async () => {
    const s = await signUpAndSignIn(api);
    const user = await userRow(s.username);
    expect(user?.signupIntent).toBeNull();
    expect(await createdEvents(s.userId)).toHaveLength(1);
  });

  test("a refused sign-up writes no event and no user", async () => {
    const u = uniqueName();
    const res = await signUp(u, { signupIntent: "chat", birthDate: "not-a-date" });
    expect(res.status).toBe(400);
    expect(await userRow(u)).toBeUndefined();
    const all = await api.db.db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(and(eq(schema.events.type, "account.created"), sql`${schema.events.payload}->>'intent' = 'chat'`));
    expect(all).toHaveLength(0);
  });

  test("the intent cannot be changed afterwards", async () => {
    const s = await signUpAndSignIn(api);
    await s.client.call("POST", "/api/auth/update-user", { signupIntent: "stream" });
    expect((await userRow(s.username))?.signupIntent).toBeNull();
  });

  test("linking a later account does not write a second account.created", async () => {
    const s = await signUpAndSignIn(api);
    const wrote = await api.db.db.transaction((tx) => recordAccountCreated(tx, s.userId, new Date()));
    expect(wrote).toBe(false);
    expect(await createdEvents(s.userId)).toHaveLength(1);
  });

  test("recordAccountCreated writes nothing for an unknown user", async () => {
    const wrote = await api.db.db.transaction((tx) => recordAccountCreated(tx, uuidv7(), new Date()));
    expect(wrote).toBe(false);
  });
});

type Availability = { username: string; available: boolean; reason: string | null };
const available = (name: string) =>
  client(api).call<Availability>("GET", `/api/usernames/available?username=${encodeURIComponent(name)}`);

describe("users.usernameAvailable", () => {
  test("a free name is available, normalized to lowercase", async () => {
    const name = uniqueName("Free");
    const res = await available(name);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ username: name.toLowerCase(), available: true, reason: null });
  });

  test("an existing user's name is taken, in any case", async () => {
    const s = await signUpAndSignIn(api);
    expect((await available(s.username)).body).toEqual({ username: s.username, available: false, reason: "taken" });
    expect((await available(s.username.toUpperCase())).body.reason).toBe("taken");
  });

  test("a channel slug held by another owner is taken", async () => {
    const s = await signUpAndSignIn(api);
    const slug = uniqueName("ch");
    await api.db.db.update(schema.channels).set({ slug }).where(eq(schema.channels.ownerId, s.userId));
    expect((await available(slug)).body.reason).toBe("taken");
  });

  test.each([["admin"], ["Settings"], ["creators"], ["tracker99"], ["admin_bob"]])("%s is reserved", async (n) => {
    expect((await available(n)).body).toMatchObject({ available: false, reason: "reserved" });
  });

  test.each([["ab"], ["has space"], ["dash-name"], ["a".repeat(26)], ["émile"]])("%j is invalid", async (n) => {
    expect((await available(n)).body).toMatchObject({ available: false, reason: "invalid" });
  });

  test("the answer never names who holds it", async () => {
    const s = await signUpAndSignIn(api);
    const body = JSON.stringify((await available(s.username)).body);
    expect(body).not.toContain(s.userId);
    expect(body).not.toContain("@");
  });
});

describe("users.usernameAvailable rate limit", () => {
  let limited: TestApi;
  beforeAll(async () => {
    limited = await startApi({ rateLimits: { lookup: { max: 3, windowMs: 60_000 } } });
  }, 60_000);
  afterAll(async () => {
    await limited?.stop();
  });

  test("its own lookup bucket applies", async () => {
    const c = client(limited);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await c.call("GET", `/api/usernames/available?username=free${i}xyz`)).status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
  });
});
