// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `portability.*` routes beyond `portability.int.test.ts`: who may move, export or import (the owner
 * only, never an editor), import reads and a start refused before it reaches the queue, the
 * one-channel grant's edges (unknown channel, no follow, off without a grant), `grants.mine`
 * ordering and avatars, `setMany` across duplicates, and the move round trip.
 *
 * No test here writes to S3 (the test bucket refuses writes in this environment): imports are
 * inserted as rows, as the preview would leave them.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { mediaUrl } from "../src/lib/dto.ts";
import { clearMove, setGrants, setMove } from "../src/portability/audience.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;

let api: TestApi;
let owner: User;
let editor: User;
let viewer: User;

beforeAll(async () => {
  api = await startApi();
  [owner, editor, viewer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  const r = await owner.client.call("PUT", `/api/channels/${owner.username}/roles/${editor.username}`, {
    role: "editor",
  });
  if (r.status !== 200) throw new Error(`grant editor: ${r.status}`);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

describe("owner-only routes", () => {
  test("an editor may manage links but not move, export or import", async () => {
    const base = `/api/channels/${owner.username}`;
    expect((await editor.client.call("GET", `${base}/move-links`)).status).toBe(200);
    expect((await editor.client.call("PUT", `${base}/moved-to`, { movedTo: "https://new.example/" })).status).toBe(403);
    expect((await editor.client.call("DELETE", `${base}/moved-to`)).status).toBe(403);
    expect((await editor.client.call("POST", `${base}/bundle`)).status).toBe(403);
    expect((await editor.client.call("POST", `${base}/imports/upload`, { sizeBytes: 10 })).status).toBe(403);
    expect((await editor.client.call("POST", `${base}/imports`, { key: "x" })).status).toBe(403);
    expect((await editor.client.call("GET", `${base}/imports`)).status).toBe(403);
    expect((await editor.client.call("GET", `${base}/imports/${uuidv7()}`)).status).toBe(403);
    expect(
      (
        await editor.client.call("POST", `${base}/imports/${uuidv7()}/start`, {
          choices: { channel: true, panels: false, emotes: [] },
        })
      ).status,
    ).toBe(403);
    // A viewer is not a manager at all.
    expect((await viewer.client.call("GET", `${base}/move-links`)).status).toBe(403);
  });
});

describe("imports reads and start", () => {
  test("list is newest first and channel-scoped; get of an unknown or foreign import is 404", async () => {
    const mine = await channelOf(owner.username);
    const theirs = await channelOf(viewer.username);
    const base = `/api/channels/${owner.username}/imports`;
    expect((await owner.client.call<unknown[]>("GET", base)).body).toEqual([]);

    const older = uuidv7();
    const newer = uuidv7();
    const foreign = uuidv7();
    await db()
      .insert(schema.portabilityImports)
      .values([
        {
          id: older,
          userId: owner.userId,
          channelId: mine.id,
          source: "commonair",
          createdAt: new Date(Date.now() - 60_000),
        },
        { id: newer, userId: owner.userId, channelId: mine.id, source: "commonair", preview: { state: "pending" } },
        { id: foreign, userId: viewer.userId, channelId: theirs.id, source: "commonair" },
      ]);
    const list = await owner.client.call<{ id: string; status: string }[]>("GET", base);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.map((i) => i.id)).toEqual([newer, older]);

    const one = await owner.client.call<{ id: string; status: string }>("GET", `${base}/${older}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: older, status: "previewed" });
    expect((await owner.client.call("GET", `${base}/${foreign}`)).status).toBe(404);
    expect((await owner.client.call("GET", `${base}/${uuidv7()}`)).status).toBe(404);
  });

  test("start refuses an unknown import and one whose preview is not ready", async () => {
    const mine = await channelOf(owner.username);
    const base = `/api/channels/${owner.username}/imports`;
    const choices = { channel: true, panels: false, emotes: [] };
    expect((await owner.client.call("POST", `${base}/${uuidv7()}/start`, { choices })).status).toBe(404);
    const id = uuidv7();
    await db()
      .insert(schema.portabilityImports)
      .values({ id, userId: owner.userId, channelId: mine.id, source: "commonair", preview: { state: "pending" } });
    expect((await owner.client.call("POST", `${base}/${id}/start`, { choices })).status).toBe(409);
    const [row] = await db().select().from(schema.portabilityImports).where(eq(schema.portabilityImports.id, id));
    expect(row?.status).toBe("previewed");
  });

  test("preview refuses a key that is not this channel's archive before touching storage", async () => {
    const r = await owner.client.call("POST", `/api/channels/${owner.username}/imports`, {
      key: "incoming/portability/elsewhere/x.zip",
    });
    expect(r.status).toBe(400);
  });

  test("upload refuses an oversized archive in the contract", async () => {
    const r = await owner.client.call("POST", `/api/channels/${owner.username}/imports/upload`, {
      sizeBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(r.status).toBe(400);
  });
});

describe("grants.set and grants.mine", () => {
  test("unknown channel 404; enabling without a follow 412; disabling without a grant is fine", async () => {
    const set = (u: User, channel: string, enabled: boolean) =>
      u.client.call<{ enabled: boolean }>("PUT", `/api/channels/${channel}/portability-grant`, { enabled });
    expect((await set(viewer, "no_such_channel_x", true)).status).toBe(404);
    expect((await set(viewer, owner.username, true)).status).toBe(412);
    const off = await set(viewer, owner.username, false);
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ enabled: false });
    expect(
      (await client(api).call("PUT", `/api/channels/${owner.username}/portability-grant`, { enabled: true })).status,
    ).toBe(401);
  });

  test("mine lists by slug with each channel's avatar; anonymous callers are refused", async () => {
    const [a, b, fan] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
    const [first, second] = [a, b].sort((x, y) => (x.username < y.username ? -1 : 1));
    if (!first || !second) throw new Error("signup");
    await db()
      .update(schema.channels)
      .set({ theme: { avatarKey: "channels/x/avatar/a.png" } })
      .where(eq(schema.channels.slug, first.username));
    await db().update(schema.users).set({ image: "avatars/owner.png" }).where(eq(schema.users.id, second.userId));
    for (const s of [second, first]) {
      await fan.client.call("PUT", `/api/channels/${s.username}/follow`, {});
      await fan.client.call("PUT", `/api/channels/${s.username}/portability-grant`, { enabled: true });
    }
    const mine = await fan.client.call<{ channel: { slug: string; avatarUrl: string | null }; createdAt: string }[]>(
      "GET",
      "/api/me/portability-grants",
    );
    expect(mine.status).toBe(200);
    expect(mine.body.map((g) => [g.channel.slug, g.channel.avatarUrl])).toEqual([
      [first.username, mediaUrl(api.deps, "channels/x/avatar/a.png")],
      [second.username, mediaUrl(api.deps, "avatars/owner.png")],
    ]);
    expect((await client(api).call("GET", "/api/me/portability-grants")).status).toBe(401);
  });
});

describe("setGrants directly", () => {
  test("no known slug and no follow both report 0; duplicates count once", async () => {
    const [s1, fan] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    expect(await setGrants(api.deps, { userId: fan.userId, slugs: ["nobody_x", "nobody_y"], enabled: false })).toEqual({
      enabled: false,
      updated: 0,
    });
    expect(await setGrants(api.deps, { userId: fan.userId, slugs: [s1.username], enabled: true })).toEqual({
      enabled: true,
      updated: 0,
    });
    await fan.client.call("PUT", `/api/channels/${s1.username}/follow`, {});
    expect(await setGrants(api.deps, { userId: fan.userId, slugs: [s1.username, s1.username], enabled: true })).toEqual(
      { enabled: true, updated: 1 },
    );
  });
});

describe("move", () => {
  test("set, same again, change, clear: events and audits as documented", async () => {
    const u = await signUpAndSignIn(api);
    const c = await channelOf(u.username);
    const moved = () =>
      db()
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.type, "channel.moved"), eq(schema.events.channelId, c.id)));
    await expect(
      setMove(api.deps, { channelId: c.id, actorId: u.userId, movedTo: "http://plain.example/" }),
    ).rejects.toThrow(/https address/);
    await expect(
      setMove(api.deps, { channelId: uuidv7(), actorId: u.userId, movedTo: "https://a.example/" }),
    ).rejects.toThrow(/not found/i);
    const first = await setMove(api.deps, { channelId: c.id, actorId: u.userId, movedTo: "https://A.example/x" });
    expect(first.movedTo).toBe("https://a.example/x");
    expect(first.movedAt).not.toBeNull();
    const same = await setMove(api.deps, { channelId: c.id, actorId: u.userId, movedTo: "https://a.example/x" });
    expect(same).toEqual(first);
    expect(await moved()).toHaveLength(1);
    await setMove(api.deps, { channelId: c.id, actorId: u.userId, movedTo: "https://b.example/" });
    expect(await moved()).toHaveLength(2);

    expect(await clearMove(api.deps, { channelId: c.id, actorId: u.userId })).toEqual({ movedTo: null, movedAt: null });
    expect(await moved()).toHaveLength(2);
    await expect(clearMove(api.deps, { channelId: uuidv7(), actorId: u.userId })).rejects.toThrow(/not found/i);
    const audits = await db()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, c.id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "portability.move.clear",
      "portability.move.set",
      "portability.move.set",
    ]);
  });
});

describe("links.resolve", () => {
  test("an unknown channel or nonce reads as unknown", async () => {
    const nonce = "x".repeat(22);
    const none = await client(api).call<{ state: string; channel: null }>(
      "GET",
      `/api/move-links/no_such_channel_x/${nonce}`,
    );
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ state: "unknown", channel: null });
    const unknown = await client(api).call<{ state: string }>("GET", `/api/move-links/${owner.username}/${nonce}`);
    expect(unknown.body).toEqual({ state: "unknown", channel: null });
  });
});
