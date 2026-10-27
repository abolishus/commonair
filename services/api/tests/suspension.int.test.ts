// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `setSuspension` with the DMCA reason never takes over a suspension that is still in force. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { liftDmcaSuspensionInTx, schema, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { setSuspension } from "../src/moderation/suspension.ts";

const { users } = schema;

let t: TestDatabase;
let db: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let n = 0;
async function makeUser(): Promise<string> {
  n += 1;
  const name = `suspuser${n}`;
  const [u] = await db
    .insert(users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: users.id });
  return u!.id;
}

async function banOf(userId: string) {
  const [u] = await db
    .select({ banned: users.banned, banReason: users.banReason, banExpires: users.banExpires })
    .from(users)
    .where(eq(users.id, userId));
  return u!;
}

const target = (userId: string) => ({ userId, channelId: null });

describe("setSuspension with the DMCA reason", () => {
  test("a timed moderation suspension survives a DMCA termination and its reversal", async () => {
    const userId = await makeUser();
    const now = new Date();
    await setSuspension(db, target(userId), "user", true, now, 3600, "moderation");
    const before = await banOf(userId);

    const dmca = await setSuspension(db, target(userId), "user", true, now, undefined, "dmca_repeat_infringer");
    expect(dmca.changed).toBe(false);
    expect(await banOf(userId)).toEqual(before);

    expect(await liftDmcaSuspensionInTx(db, userId)).toBe(false);
    const after = await banOf(userId);
    expect(after.banned).toBe(true);
    expect(after.banReason).toBe("moderation");
    expect(after.banExpires?.getTime()).toBe(before.banExpires?.getTime());
  });

  test("a permanent moderation suspension is left alone", async () => {
    const userId = await makeUser();
    const now = new Date();
    await setSuspension(db, target(userId), "user", true, now, undefined, "moderation");
    const dmca = await setSuspension(db, target(userId), "user", true, now, undefined, "dmca_repeat_infringer");
    expect(dmca.changed).toBe(false);
    expect(await banOf(userId)).toMatchObject({ banned: true, banReason: "moderation", banExpires: null });
  });

  test("an unsuspended user gets the DMCA suspension, and lifting it unbans", async () => {
    const userId = await makeUser();
    const dmca = await setSuspension(db, target(userId), "user", true, new Date(), undefined, "dmca_repeat_infringer");
    expect(dmca.changed).toBe(true);
    expect(await banOf(userId)).toMatchObject({ banned: true, banReason: "dmca_repeat_infringer", banExpires: null });
    expect(await liftDmcaSuspensionInTx(db, userId)).toBe(true);
    expect((await banOf(userId)).banned).toBe(false);
  });

  test("an expired moderation suspension does not block the DMCA suspension", async () => {
    const userId = await makeUser();
    const past = new Date(Date.now() - 7200_000);
    await setSuspension(db, target(userId), "user", true, past, 60, "moderation");
    const dmca = await setSuspension(db, target(userId), "user", true, new Date(), undefined, "dmca_repeat_infringer");
    expect(dmca.changed).toBe(true);
    expect(await banOf(userId)).toMatchObject({ banned: true, banReason: "dmca_repeat_infringer", banExpires: null });
  });

  test("a moderation suspension still replaces a DMCA one", async () => {
    const userId = await makeUser();
    const now = new Date();
    await setSuspension(db, target(userId), "user", true, now, undefined, "dmca_repeat_infringer");
    const mod = await setSuspension(db, target(userId), "user", true, now, undefined, "moderation");
    expect(mod.changed).toBe(true);
    expect((await banOf(userId)).banReason).toBe("moderation");
    expect(await liftDmcaSuspensionInTx(db, userId)).toBe(false);
  });
});
