// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { client, mailTo, signUpAndSignIn, solveAltcha, startApi, uniqueName, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

const signUp = async (body: Record<string, unknown>) => client(api).call("POST", "/api/auth/sign-up/email", body);
const base = (username: string) => ({
  email: `${username}@test.invalid`,
  password: `pw-${crypto.randomUUID()}`,
  name: username,
  username,
});

describe("signup gates", () => {
  test("refuses signups without a valid ALTCHA solution", async () => {
    const u = uniqueName();
    const missing = await signUp({ ...base(u), birthDate: "1990-01-01" });
    expect(missing.status).toBe(400);
    const forged = await signUp({ ...base(u), birthDate: "1990-01-01", altcha: Buffer.from("{}").toString("base64") });
    expect(forged.status).toBe(400);
  });

  test("an ALTCHA solution works once", async () => {
    const altcha = await solveAltcha(api);
    const a = uniqueName();
    expect((await signUp({ ...base(a), birthDate: "1990-01-01", altcha })).status).toBe(200);
    const b = uniqueName();
    const replay = await signUp({ ...base(b), birthDate: "1990-01-01", altcha });
    expect(replay.status).toBe(400);
  });

  test("under-13 is refused and nothing is stored", async () => {
    const u = uniqueName();
    const now = new Date();
    const twelve = `${now.getUTCFullYear() - 12}-01-01`;
    const res = await signUp({ ...base(u), birthDate: twelve, altcha: await solveAltcha(api) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("TOO_YOUNG");
    const rows = await api.db.db.select().from(schema.users).where(eq(schema.users.username, u));
    expect(rows).toHaveLength(0);
    const missing = await signUp({ ...base(uniqueName()), altcha: await solveAltcha(api) });
    expect(missing.status).toBe(400);
  });

  test("reserved and malformed usernames are refused", async () => {
    for (const username of ["admin", "settings", "x"]) {
      const res = await signUp({ ...base(uniqueName()), username, birthDate: "1990-01-01", altcha: await solveAltcha(api) });
      expect(res.status, username).toBe(400);
    }
  });
});

test("signup → verification email in Mailpit → sign-in; channel auto-created", async () => {
  const s = await signUpAndSignIn(api);
  const mail = await mailTo(s.email);
  expect(mail?.subject).toMatch(/confirm your email/i);
  expect(mail?.text).toContain(`${api.url}/api/auth/verify-email?token=`);
  const me = await s.client.call<{ username: string; channelSlug: string; emailVerified: boolean; isAdult: boolean }>(
    "GET",
    "/api/me",
  );
  expect(me.status, JSON.stringify(me.body)).toBe(200);
  expect(me.body).toMatchObject({ username: s.username, channelSlug: s.username, emailVerified: true, isAdult: true });
  const [user] = await api.db.db.select().from(schema.users).where(eq(schema.users.username, s.username));
  expect(user?.birthDate).toBe("1990-05-05");
  expect(user?.accountType).toBe("human");
  const [channel] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.ownerId, s.userId));
  expect(channel?.slug).toBe(s.username);
  const pub = await client(api).call<{ slug: string; owner: { username: string } }>("GET", `/api/channels/${s.username}`);
  expect(pub.body).toMatchObject({ slug: s.username, owner: { username: s.username } });
});

test("signing in before verifying the email is refused", async () => {
  const u = uniqueName();
  const b = base(u);
  expect((await signUp({ ...b, birthDate: "1990-01-01", altcha: await solveAltcha(api) })).status).toBe(200);
  const res = await client(api).call("POST", "/api/auth/sign-in/email", { email: b.email, password: b.password });
  expect(res.status).toBe(403);
});
