// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { instanceMediaBase } from "../src/lib/media-ref.ts";
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
  test("the database guard rejects an avatar update that waits behind a committed tombstone", async () => {
    const [channel] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.ownerId, member.userId));
    if (!channel) throw new Error("member channel not found");
    const key = `channels/${channel.id}/avatar/race.png`;
    const url = `${instanceMediaBase(api.deps.env)}${key}`;
    let release!: () => void;
    let locked!: () => void;
    const mayCommit = new Promise<void>((resolve) => (release = resolve));
    const lockAcquired = new Promise<void>((resolve) => (locked = resolve));

    const removal = api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
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
      locked();
      await mayCommit;
    });

    await lockAcquired;
    let writerStarted!: () => void;
    const writerReady = new Promise<void>((resolve) => (writerStarted = resolve));
    let writerPid: number | undefined;
    const writer = api.db.db.transaction(async (tx) => {
      const [process] = await tx.execute(sql`select pg_backend_pid()::int as pid`);
      writerPid = Number(process?.pid);
      writerStarted();
      await tx.update(schema.users).set({ image: key }).where(eq(schema.users.id, member.userId));
    });
    const writerOutcome = writer.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );
    await writerReady;
    if (!writerPid) throw new Error("writer connection pid unavailable");
    let waitingOnLock = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const [activity] = await api.db.db.execute(
        sql`select wait_event_type from pg_stat_activity where pid = ${writerPid}`,
      );
      if (activity?.wait_event_type === "Lock") {
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
    const outcome = await writerOutcome;
    expect(outcome.error).toBeInstanceOf(Error);
    let failure: unknown = outcome.error;
    let databaseMessage = "";
    while (failure instanceof Error) {
      databaseMessage += `${failure.message} `;
      failure = failure.cause;
    }
    expect(databaseMessage).toMatch(/profile image is unavailable/);
  });
});
