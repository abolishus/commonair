// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul D4.7 trust marks: `Channel.ownerCoop` from `channels.get`. `member` is an active
 * membership row now (an exited or lapsed one does not count); `council` is a seat on the current
 * council term (not an expired term's seat).
 *
 * This file owns its database (`startApi` → `createTestDatabase()`).
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { ownerCoop } from "../src/channels/owner-coop.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;

async function channelCoop(slug: string) {
  const r = await client(api).call<{ ownerCoop: { member: boolean; council: boolean } }>(
    "GET",
    `/api/channels/${slug}`,
  );
  expect(r.status).toBe(200);
  return r.body.ownerCoop;
}

async function seatCouncil(userIds: string[], window: { startsAt: Date; endsAt: Date }) {
  // Seats go in with the term, in one transaction (0021).
  await db().transaction(async (tx) => {
    const [term] = await tx
      .insert(schema.councilTerms)
      .values({ ...window, method: { version: "test", size: userIds.length } })
      .returning();
    if (!term) throw new Error("no term");
    await tx
      .insert(schema.councilMembers)
      .values(userIds.map((userId, i) => ({ termId: term.id, userId, rank: i + 1, contributionScore: 1 })));
  });
}

describe("Channel.ownerCoop", () => {
  test("member, council, neither, ended membership and an expired seat", async () => {
    const [member, councillor, neither, ended, expired] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    await db()
      .insert(schema.memberships)
      .values([
        { userId: member.userId, class: "viewer", basis: "subscription" },
        {
          userId: ended.userId,
          class: "viewer",
          basis: "subscription",
          status: "exited",
          exitedAt: new Date(Date.now() - 60_000),
        },
      ]);
    const now = Date.now();
    // An expired term seated `expired`; the current one seats `councillor`.
    await seatCouncil([expired.userId], { startsAt: new Date(now - 2 * 86_400_000), endsAt: new Date(now - 60_000) });
    await seatCouncil([councillor.userId], { startsAt: new Date(now - 60_000), endsAt: new Date(now + 86_400_000) });

    expect(await channelCoop(member.username)).toEqual({ member: true, council: false });
    expect(await channelCoop(councillor.username)).toEqual({ member: false, council: true });
    expect(await channelCoop(neither.username)).toEqual({ member: false, council: false });
    expect(await channelCoop(ended.username)).toEqual({ member: false, council: false });
    expect(await channelCoop(expired.username)).toEqual({ member: false, council: false });

    // Directly: the one-query probe agrees.
    expect(await ownerCoop(api.deps, member.userId)).toEqual({ member: true, council: false });
  }, 120_000);
});
