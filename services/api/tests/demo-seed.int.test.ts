// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The demo seed (packages/db `demo:seed`) writes accounts straight into Postgres. Its password
 * hashes must match the pinned better-auth, so a seeded user signs in through the real API, and
 * the `demo_` prefix stays closed to real sign-ups.
 */
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { clearDemo } from "../../../packages/db/src/demo/clear.ts";
import { seedDemo } from "../../../packages/db/src/demo/seed.ts";
import { client, solveAltcha, startApi, type TestApi } from "./harness.ts";

const PASSWORD = "demo-seed-int-password";
let api: TestApi;

beforeAll(async () => {
  api = await startApi();
  const result = await seedDemo(api.db.app.db, { password: PASSWORD });
  if (result.status !== "seeded") throw new Error("demo seed did not run");
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

test("a seeded streamer signs in with email and password", async () => {
  const c = client(api);
  const res = await c.call("POST", "/api/auth/sign-in/email", {
    email: "demo_streamer1@demo-seed.invalid",
    password: PASSWORD,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const me = await c.call<{ username: string; channelSlug: string | null }>("GET", "/api/me");
  expect(me.status).toBe(200);
  expect(me.body.username).toBe("demo_streamer1");
  expect(me.body.channelSlug).toBe("demo_streamer1");
});

test("a seeded viewer signs in by email; username sign-in is refused for the reserved prefix", async () => {
  const c = client(api);
  const res = await c.call("POST", "/api/auth/sign-in/email", {
    email: "demo_viewer3@demo-seed.invalid",
    password: PASSWORD,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const me = await c.call<{ username: string }>("GET", "/api/me");
  expect(me.body.username).toBe("demo_viewer3");
  // better-auth's username plugin runs the same validator on sign-in, and `demo_` is reserved.
  const byName = await client(api).call("POST", "/api/auth/sign-in/username", {
    username: "demo_viewer3",
    password: PASSWORD,
  });
  expect(byName.status).toBe(422);
});

test("a wrong password is refused", async () => {
  const res = await client(api).call("POST", "/api/auth/sign-in/email", {
    email: "demo_viewer1@demo-seed.invalid",
    password: `${PASSWORD}x`,
  });
  expect(res.status).toBe(401);
});

test("the seeded bot has no password sign-in", async () => {
  const res = await client(api).call("POST", "/api/auth/sign-in/email", {
    email: "demo_bot1@demo-seed.invalid",
    password: PASSWORD,
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
});

test("seeded channels are public through the API", async () => {
  const res = await client(api).call<{ slug: string; title: string; followerCount: number }>(
    "GET",
    "/api/channels/demo_streamer3",
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.title).toContain("roguelike");
  expect(res.body.followerCount).toBeGreaterThan(0);
});

test("real sign-ups can never take a demo_ username", async () => {
  for (const [username, email] of [
    ["demo_newcomer", "newcomer@test.invalid"],
    ["demo_newcomer2", "demo_newcomer2@demo-seed.invalid"],
  ] as const) {
    const res = await client(api).call("POST", "/api/auth/sign-up/email", {
      email,
      password: `pw-${crypto.randomUUID()}`,
      name: username,
      username,
      birthDate: "1990-01-01",
      altcha: await solveAltcha(api),
    });
    expect(res.status, username).toBe(400);
    expect(JSON.stringify(res.body)).toContain("INVALID_USERNAME");
  }
});

test("after demo:clear the accounts are gone", async () => {
  await clearDemo(api.db.app.db, { execute: true });
  const res = await client(api).call("POST", "/api/auth/sign-in/email", {
    email: "demo_streamer1@demo-seed.invalid",
    password: PASSWORD,
  });
  expect(res.status).toBe(401);
});
