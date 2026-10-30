// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.unreadCount` against Postgres (ADR 0028; N1-inbox). */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { schema } from "@commonair/db";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const PATH = "/api/notifications/unread-count";

async function insertRows(userId: string, n: number, read = false): Promise<void> {
  if (n === 0) return;
  await db()
    .insert(schema.notifications)
    .values(
      Array.from({ length: n }, (_, i) => ({
        userId,
        type: "system" as const,
        payload: { kind: "test", i },
        readAt: read ? new Date() : null,
      })),
    );
}

describe("notifications.unreadCount", () => {
  test("0, then 3 (read rows and another member's rows ignored), then mark-read brings it back to 0", async () => {
    const me = await signUpAndSignIn(api);
    const other = await signUpAndSignIn(api);
    const zero = await me.client.call<{ count: number; capped: boolean }>("GET", PATH);
    expect(zero.status, JSON.stringify(zero.body)).toBe(200);
    expect(zero.body).toEqual({ count: 0, capped: false });

    await insertRows(me.userId, 3);
    await insertRows(me.userId, 2, true);
    await insertRows(other.userId, 7);
    const three = await me.client.call<{ count: number; capped: boolean }>("GET", PATH);
    expect(three.body).toEqual({ count: 3, capped: false });
    const theirs = await other.client.call<{ count: number; capped: boolean }>("GET", PATH);
    expect(theirs.body).toEqual({ count: 7, capped: false });

    const read = await me.client.call("POST", "/api/me/notifications/read", {});
    expect(read.status).toBe(200);
    const after = await me.client.call<{ count: number; capped: boolean }>("GET", PATH);
    expect(after.body).toEqual({ count: 0, capped: false });
  });

  test("exactly the cap is not capped; 120 rows are capped at 99", async () => {
    const cap = NOTIFY_RULES.unreadCountCap;
    expect(cap).toBe(99);
    const me = await signUpAndSignIn(api);
    await insertRows(me.userId, cap);
    const atCap = await me.client.call<{ count: number; capped: boolean }>("GET", PATH);
    expect(atCap.body).toEqual({ count: cap, capped: false });

    await insertRows(me.userId, 120 - cap);
    const capped = await me.client.call<{ count: number; capped: boolean }>("GET", PATH);
    expect(capped.body).toEqual({ count: cap, capped: true });
  });

  test("signed out: UNAUTHORIZED", async () => {
    const res = await fetch(`${api.url}${PATH}`);
    expect(res.status).toBe(401);
  });
});
