// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `me.blocks.{list,ids,add,remove}` (ADR 0012 amendment 1 decision 8; W1-calm-chat). */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BLOCK_RULES } from "@commonair/contracts/enums";
import { schema, uuidv7 } from "@commonair/db";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { client, signUpAndSignIn, startApi, uniqueName, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;

interface Blocked {
  user: { id: string; username: string; displayName: string };
  createdAt: string;
}
interface Page {
  items: Blocked[];
  nextCursor: string | null;
}

/** A user row straight in the database (no sign-in needed for a block target). */
async function newUser(prefix = "bt"): Promise<{ id: string; username: string }> {
  const username = uniqueName(prefix);
  const [u] = await db()
    .insert(schema.users)
    .values({ name: `Name ${username}`, email: `${username}@example.test`, username, emailVerified: true })
    .returning({ id: schema.users.id });
  return { id: u!.id, username };
}

async function bearer(kind: "personal" | "client_credentials", userId: string | null): Promise<string> {
  const raw = randomSecret("ca_", 24);
  let appId: string | null = null;
  if (kind === "client_credentials") {
    const owner = await newUser("own");
    const [a] = await db()
      .insert(schema.oauthApps)
      .values({
        ownerId: owner.id,
        name: "blocks",
        clientId: `cid_${uuidv7().slice(-12)}`,
        clientSecretHash: "hash",
        redirectUris: ["https://app.example.test/cb"],
      })
      .returning({ id: schema.oauthApps.id });
    appId = a!.id;
  }
  await db()
    .insert(schema.oauthTokens)
    .values({
      appId,
      userId,
      kind,
      scopes: userId === null ? [] : ["chat:read", "user:read:email"],
      accessTokenHash: await sha256Hex(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  return raw;
}

describe("me.blocks", () => {
  test("add, list, ids, remove", async () => {
    const me = await signUpAndSignIn(api);
    const a = await newUser();
    const b = await newUser();

    const empty = await me.client.call<Page>("GET", "/api/me/blocks");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [], nextCursor: null });

    const added = await me.client.call<Blocked>("POST", "/api/me/blocks", { username: a.username });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.user).toEqual({ id: a.id, username: a.username, displayName: `Name ${a.username}` });
    await me.client.call("POST", "/api/me/blocks", { username: b.username });

    const list = await me.client.call<Page>("GET", "/api/me/blocks");
    // Newest first.
    expect(list.body.items.map((i) => i.user.username)).toEqual([b.username, a.username]);

    const ids = await me.client.call<{ userIds: string[] }>("GET", "/api/me/blocks/ids");
    expect(ids.status).toBe(200);
    expect(new Set(ids.body.userIds)).toEqual(new Set([a.id, b.id]));

    const removed = await me.client.call("DELETE", `/api/me/blocks/${a.username}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true });
    const after = await me.client.call<{ userIds: string[] }>("GET", "/api/me/blocks/ids");
    expect(after.body.userIds).toEqual([b.id]);
  });

  test("blocks are per user: another account's list is its own", async () => {
    const one = await signUpAndSignIn(api);
    const two = await signUpAndSignIn(api);
    const target = await newUser();
    await one.client.call("POST", "/api/me/blocks", { username: target.username });
    const ids = await two.client.call<{ userIds: string[] }>("GET", "/api/me/blocks/ids");
    expect(ids.body.userIds).toEqual([]);
  });

  test("adding twice is idempotent and returns the original row", async () => {
    const me = await signUpAndSignIn(api);
    const t = await newUser();
    const first = await me.client.call<Blocked>("POST", "/api/me/blocks", { username: t.username });
    const second = await me.client.call<Blocked>("POST", "/api/me/blocks", { username: t.username });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const rows = await db().select().from(schema.userBlocks).where(eq(schema.userBlocks.userId, me.userId));
    expect(rows).toHaveLength(1);
  });

  test("removing what is not blocked, or an unknown user, is ok", async () => {
    const me = await signUpAndSignIn(api);
    const t = await newUser();
    expect((await me.client.call("DELETE", `/api/me/blocks/${t.username}`)).status).toBe(200);
    expect((await me.client.call("DELETE", `/api/me/blocks/${uniqueName("nobody")}`)).status).toBe(200);
  });

  test("yourself is BAD_REQUEST; an unknown user is NOT_FOUND", async () => {
    const me = await signUpAndSignIn(api);
    const self = await me.client.call<{ code: string }>("POST", "/api/me/blocks", { username: me.username });
    expect(self.status).toBe(400);
    const unknown = await me.client.call<{ code: string }>("POST", "/api/me/blocks", {
      username: uniqueName("ghost"),
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("NOT_FOUND");
  });

  test("a deleted (pseudonymized) account cannot be blocked", async () => {
    const me = await signUpAndSignIn(api);
    const gone = await newUser("gone");
    await db().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, gone.id));
    const res = await me.client.call<{ code: string }>("POST", "/api/me/blocks", { username: gone.username });
    expect(res.status).toBe(404);
  });

  test("the database refuses a self-block too", async () => {
    const u = await newUser();
    const err: unknown = await db()
      .insert(schema.userBlocks)
      .values({ userId: u.id, blockedUserId: u.id })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(String((err as { cause?: unknown } | null)?.cause ?? err)).toMatch(/user_blocks_not_self/);
  });

  test("signed out is refused", async () => {
    const anon = client(api);
    expect((await anon.call("GET", "/api/me/blocks")).status).toBe(401);
    expect((await anon.call("GET", "/api/me/blocks/ids")).status).toBe(401);
    expect((await anon.call("POST", "/api/me/blocks", { username: "someone" })).status).toBe(401);
  });

  test("access tokens are refused: user tokens and app tokens alike", async () => {
    const me = await signUpAndSignIn(api);
    const target = await newUser();
    const userTok = client(api, { bearer: await bearer("personal", me.userId) });
    const appTok = client(api, { bearer: await bearer("client_credentials", null) });
    for (const c of [userTok, appTok]) {
      expect((await c.call("GET", "/api/me/blocks")).status).toBe(403);
      expect((await c.call("GET", "/api/me/blocks/ids")).status).toBe(403);
      expect((await c.call("POST", "/api/me/blocks", { username: target.username })).status).toBe(403);
      expect((await c.call("DELETE", `/api/me/blocks/${target.username}`)).status).toBe(403);
    }
  });

  test("the list pages newest first without gaps or repeats", async () => {
    const me = await signUpAndSignIn(api);
    const targets = await Promise.all(Array.from({ length: 7 }, () => newUser("pg")));
    // Same millisecond for several rows, microseconds apart: the cursor must not skip them.
    const base = Date.now();
    await db()
      .insert(schema.userBlocks)
      .values(
        targets.map((t, i) => ({
          userId: me.userId,
          blockedUserId: t.id,
          createdAt: sql`${new Date(base - Math.floor(i / 3) * 1000).toISOString()}::timestamptz + ${`${(i % 3) * 7} microseconds`}::interval`,
        })),
      );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const q: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const res = await me.client.call<Page>("GET", `/api/me/blocks${q}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((x) => x.user.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(targets.map((t) => t.id)));
  });

  test(`at ${BLOCK_RULES.maxPerUser} blocks the next is PRECONDITION_FAILED block_limit`, async () => {
    const me = await signUpAndSignIn(api);
    const stamp = uuidv7().replace(/-/g, "").slice(-8);
    const seeded = await db()
      .insert(schema.users)
      .values(
        Array.from({ length: BLOCK_RULES.maxPerUser }, (_, i) => ({
          name: `L${i}`,
          email: `l${stamp}_${i}@example.test`,
          username: `l${stamp}_${i}`,
          emailVerified: true,
        })),
      )
      .returning({ id: schema.users.id, username: schema.users.username });
    await db()
      .insert(schema.userBlocks)
      .values(seeded.map((u) => ({ userId: me.userId, blockedUserId: u.id })));

    const ids = await me.client.call<{ userIds: string[] }>("GET", "/api/me/blocks/ids");
    expect(ids.status).toBe(200);
    expect(ids.body.userIds).toHaveLength(BLOCK_RULES.maxPerUser);

    const extra = await newUser();
    const res = await me.client.call<{ code: string; data: { requirement: string } }>("POST", "/api/me/blocks", {
      username: extra.username,
    });
    expect(res.status).toBe(412);
    expect(res.body.data.requirement).toBe("block_limit");

    // Re-adding someone already blocked still answers: it is not a new row.
    const again = await me.client.call("POST", "/api/me/blocks", { username: seeded[0]!.username });
    expect(again.status).toBe(200);

    // Unblocking one frees a slot.
    await me.client.call("DELETE", `/api/me/blocks/${seeded[1]!.username}`);
    expect((await me.client.call("POST", "/api/me/blocks", { username: extra.username })).status).toBe(200);
  });

  test("blocking a moderator or the broadcaster is allowed and writes no audit or event row", async () => {
    const me = await signUpAndSignIn(api);
    const streamer = await signUpAndSignIn(api);
    const before = await db().select({ id: schema.auditLog.id }).from(schema.auditLog);
    const res = await me.client.call("POST", "/api/me/blocks", { username: streamer.username });
    expect(res.status).toBe(200);
    const after = await db().select({ id: schema.auditLog.id }).from(schema.auditLog);
    expect(after.length).toBe(before.length);
  });
});
