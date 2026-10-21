// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { instanceMediaBase } from "../src/lib/media-ref.ts";
import { lockUploadReference } from "../src/moderation/committed.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
let member: Awaited<ReturnType<typeof signUpAndSignIn>>;

beforeAll(async () => {
  api = await startApi();
  member = await signUpAndSignIn(api);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("avatar NCII revocation guard", () => {
  test("a tombstoned avatar cannot be reattached through Better Auth", async () => {
    const [channel] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.ownerId, member.userId));
    if (!channel) throw new Error("member channel not found");
    const key = `channels/${channel.id}/avatar/revoked.png`;
    const url = `${instanceMediaBase(api.deps.env)}${key}`;
    const [request] = await api.db.db
      .insert(schema.nciiRequests)
      .values({
        requesterName: "Synthetic requester",
        requesterEmail: "requester@test.invalid",
        relationship: "self",
        contentUrls: [url],
        description: "Synthetic fixture revocation test",
        goodFaith: true,
        signature: "Synthetic signature",
        deadlineAt: new Date(),
      })
      .returning();
    if (!request) throw new Error("request insert returned no row");
    await api.db.db.insert(schema.nciiRequestItems).values({
      requestId: request.id,
      url,
      subjectType: "upload",
      subjectId: channel.id,
      uploadKey: key,
      removedAt: new Date(),
    });

    const response = await member.client.call("POST", "/api/auth/update-user", { image: key });
    expect(response.status).toBe(400);
    const [user] = await api.db.db.select().from(schema.users).where(eq(schema.users.id, member.userId));
    expect(user?.image).not.toBe(key);
  });

  test("an avatar reattach that races NCII removal waits, then is rejected", async () => {
    const [channel] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.ownerId, member.userId));
    if (!channel) throw new Error("member channel not found");
    const key = `channels/${channel.id}/avatar/race.png`;
    const url = `${instanceMediaBase(api.deps.env)}${key}`;
    let release!: () => void;
    let locked!: () => void;
    const mayCommit = new Promise<void>((resolve) => (release = resolve));
    const lockAcquired = new Promise<void>((resolve) => (locked = resolve));

    const removal = api.db.db.transaction(async (tx) => {
      await lockUploadReference(tx, key);
      const [request] = await tx
        .insert(schema.nciiRequests)
        .values({
          requesterName: "Synthetic requester",
          requesterEmail: "requester@test.invalid",
          relationship: "self",
          contentUrls: [url],
          description: "Synthetic fixture race test",
          goodFaith: true,
          signature: "Synthetic signature",
          deadlineAt: new Date(),
        })
        .returning();
      if (!request) throw new Error("request insert returned no row");
      await tx.insert(schema.nciiRequestItems).values({
        requestId: request.id,
        url,
        subjectType: "upload",
        subjectId: channel.id,
        uploadKey: key,
        removedAt: new Date(),
      });
      await tx.update(schema.users).set({ image: null }).where(eq(schema.users.id, member.userId));
      locked();
      await mayCommit;
    });

    await lockAcquired;
    const reattach = member.client.call("POST", "/api/auth/update-user", { image: key });
    let waitingOnLock = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const [waiter] = await api.db.db.execute(sql`
        select pid from pg_stat_activity
        where wait_event_type = 'Lock' and state = 'active'
        limit 1
      `);
      if (waiter) {
        waitingOnLock = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      expect(waitingOnLock).toBe(true);
    } finally {
      release();
      await removal;
    }
    expect((await reattach).status).toBe(400);
    const [user] = await api.db.db.select().from(schema.users).where(eq(schema.users.id, member.userId));
    expect(user?.image).toBeNull();
  });
});
