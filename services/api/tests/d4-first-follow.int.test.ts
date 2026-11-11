// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `channels.follow` → `firstFollow` (overhaul wave 3, D4.3): true only when the insert created the
 * caller's only follows row, so the web offers go-live alerts once.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Followed = { following: true; followerCount: number; firstFollow: boolean };

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const people = async (n: number): Promise<User[]> => Promise.all(Array.from({ length: n }, () => signUpAndSignIn(api)));
const follow = async (fan: User, owner: User, body: { notify?: boolean } = {}) => {
  const res = await fan.client.call<Followed>("PUT", `/api/channels/${owner.username}/follow`, body);
  expect(res.status).toBe(200);
  return res.body;
};
const unfollow = (fan: User, owner: User) => fan.client.call("DELETE", `/api/channels/${owner.username}/follow`);
const followsOf = (fan: User) =>
  api.db.db
    .select({ channelId: schema.follows.channelId, notify: schema.follows.notify })
    .from(schema.follows)
    .where(eq(schema.follows.followerId, fan.userId));

describe("channels.follow firstFollow", () => {
  test("the first follow is first; a second channel is not", async () => {
    const [a, b, fan] = await people(3);
    if (!a || !b || !fan) throw new Error("signup");
    expect((await follow(fan, a)).firstFollow).toBe(true);
    expect((await follow(fan, b)).firstFollow).toBe(false);
  });

  test("the existing-follow update path (notify) is never first", async () => {
    const [a, fan] = await people(2);
    if (!a || !fan) throw new Error("signup");
    expect((await follow(fan, a)).firstFollow).toBe(true);
    expect((await follow(fan, a, { notify: false })).firstFollow).toBe(false);
    expect(await followsOf(fan)).toEqual([expect.objectContaining({ notify: false })]);
  });

  test("re-following after an unfollow, while other follows exist, is not first", async () => {
    const [a, b, fan] = await people(3);
    if (!a || !b || !fan) throw new Error("signup");
    await follow(fan, a);
    await follow(fan, b);
    expect((await unfollow(fan, a)).status).toBe(200);
    expect(await follow(fan, a)).toMatchObject({ following: true, firstFollow: false });
    expect(await followsOf(fan)).toHaveLength(2);
  });

  test("another viewer's follows do not count against the caller", async () => {
    const [a, other, fan] = await people(3);
    if (!a || !other || !fan) throw new Error("signup");
    expect((await follow(other, a)).firstFollow).toBe(true);
    expect((await follow(fan, a)).firstFollow).toBe(true);
  });
});
