// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `portability.grants.setMany` ("all on / all off"): the `grants.set` rules per channel (a grant
 * needs a follow), in one call; unknown slugs are skipped; `updated` counts real changes, so a
 * repeat reports 0.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Result = { enabled: boolean; updated: number };

let api: TestApi;

beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const follow = (u: User, channel: string) => u.client.call("PUT", `/api/channels/${channel}/follow`, { notify: true });
const setMany = (u: User, channels: string[], enabled: boolean) =>
  u.client.call<Result>("PUT", "/api/me/portability-grants", { channels, enabled });
const granted = async (u: User) =>
  (await u.client.call<{ channel: { slug: string } }[]>("GET", "/api/me/portability-grants")).body
    .map((g) => g.channel.slug)
    .sort();

describe("grants.setMany", () => {
  test("on, off, idempotent; unknown and unfollowed channels skipped", async () => {
    const [s1, s2, s3, u, other] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    await follow(u, s1.username);
    await follow(u, s2.username);
    await follow(other, s1.username);
    await other.client.call("PUT", `/api/channels/${s1.username}/portability-grant`, { enabled: true });
    // One grant already on: only the second is a change.
    await u.client.call("PUT", `/api/channels/${s1.username}/portability-grant`, { enabled: true });

    const all = [s1.username, s2.username, s3.username, "nobody_here_x"];
    const on = await setMany(u, all, true);
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ enabled: true, updated: 1 });
    // s3 is not followed: as `grants.set`, no grant without a follow.
    expect(await granted(u)).toEqual([s1.username, s2.username].sort());
    expect((await setMany(u, all, true)).body).toEqual({ enabled: true, updated: 0 });

    expect((await setMany(u, [s2.username, s2.username], false)).body).toEqual({ enabled: false, updated: 1 });
    expect(await granted(u)).toEqual([s1.username]);
    expect((await setMany(u, all, false)).body).toEqual({ enabled: false, updated: 1 });
    expect(await granted(u)).toEqual([]);
    expect((await setMany(u, all, false)).body).toEqual({ enabled: false, updated: 0 });
    // Someone else's grant is untouched.
    expect(await granted(other)).toEqual([s1.username]);

    expect((await setMany(u, ["nobody_here_x"], true)).body).toEqual({ enabled: true, updated: 0 });
    expect((await setMany(u, [], true)).status).toBe(400);
    const [row] = await api.db.db
      .select()
      .from(schema.followPortabilityGrants)
      .where(eq(schema.followPortabilityGrants.userId, u.userId));
    expect(row).toBeUndefined();
  });
});
