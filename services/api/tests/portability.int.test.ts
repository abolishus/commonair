// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `portability.*` (ADR 0037): move-link limits, revoke and landing states; attribution only on a
 * new follow through a live link; conversions that exclude excluded follows (and the trigger-kept
 * count); grants; the move's URL validation and its event; the import flow's API half against a
 * stand-in worker; the bundle export request.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { MOVE_LINK_RULES } from "@commonair/contracts/enums";
import { schema, uuidv7 } from "@commonair/db";
import { setPortabilityQueue, type PortabilityQueue } from "../src/portability/queue.ts";
import { setExportQueue } from "../src/privacy/export-queue.ts";
import { applyUnsubscribe } from "../src/notifications/unsubscribe/apply.ts";
import { signUnsubscribeToken } from "@commonair/tokens";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let owner: User;
let viewer: User;
let other: User;
const db = () => api.db.db;

/** What the worker would do for a preview, scripted per test. */
let previewBehaviour: (importId: string) => Promise<void> = async () => {};
const started: string[] = [];
const queue: PortabilityQueue = {
  preview: (id) => previewBehaviour(id),
  start: async (id) => {
    started.push(id);
  },
  close: async () => {},
};

beforeAll(async () => {
  api = await startApi();
  setPortabilityQueue(api.deps, queue);
  setExportQueue(api.deps, { enqueue: async () => {}, close: async () => {} });
  [owner, viewer, other] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

interface Link {
  id: string;
  createdAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  conversions: number;
}
type Created = Link & { nonce: string; url: string };

async function channelOf(u: User) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, u.userId));
  return c!;
}
const createLink = (u: User, body: Record<string, unknown> = {}) =>
  u.client.call<Created>("POST", `/api/channels/${u.username}/move-links`, body);
const follow = (u: User, channel: string, nonce?: string) =>
  u.client.call<{ following: boolean; followerCount: number }>("PUT", `/api/channels/${channel}/follow`, {
    notify: true,
    ...(nonce ? { moveLink: { nonce } } : {}),
  });
const followRow = async (followerId: string, channelId: string) =>
  (
    await db()
      .select()
      .from(schema.follows)
      .where(and(eq(schema.follows.followerId, followerId), eq(schema.follows.channelId, channelId)))
  )[0];

describe("move links", () => {
  test("create shows the nonce once; list and resolve never do", async () => {
    const r = await createLink(owner);
    expect(r.status).toBe(200);
    expect(r.body.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.body.url).toBe(`${api.url}/m/${owner.username}/${r.body.nonce}`);
    const [row] = await db().select().from(schema.moveLinks).where(eq(schema.moveLinks.id, r.body.id));
    expect(row?.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.nonceHash).not.toContain(r.body.nonce);
    const list = await owner.client.call<Link[]>("GET", `/api/channels/${owner.username}/move-links`);
    expect(list.body.find((l) => l.id === r.body.id)).toEqual({
      id: r.body.id,
      createdAt: r.body.createdAt,
      revokedAt: null,
      expiresAt: null,
      conversions: 0,
    });
    expect(JSON.stringify(list.body)).not.toContain(r.body.nonce);
    const res = await other.client.call<{ state: string; channel: { slug: string } | null }>(
      "GET",
      `/api/move-links/${owner.username}/${r.body.nonce}`,
    );
    expect(res.body).toMatchObject({ state: "active", channel: { slug: owner.username } });
  });

  test("only the channel's managers list or create links", async () => {
    expect((await other.client.call("GET", `/api/channels/${owner.username}/move-links`)).status).toBe(403);
    expect((await other.client.call("POST", `/api/channels/${owner.username}/move-links`, {})).status).toBe(403);
  });

  test("an expiry in the past is refused; a future one reads as expired once it passes", async () => {
    const past = await createLink(owner, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(past.status).toBe(400);
    const r = await createLink(owner, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(r.status).toBe(200);
    await db()
      .update(schema.moveLinks)
      .set({ expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.moveLinks.id, r.body.id));
    const res = await viewer.client.call<{ state: string }>("GET", `/api/move-links/${owner.username}/${r.body.nonce}`);
    expect(res.body.state).toBe("expired");
  });

  test("revoke: the link reads as revoked, revoking twice is a no-op, an unknown id is 404", async () => {
    const r = await createLink(owner);
    const del = await owner.client.call<Link>("DELETE", `/api/channels/${owner.username}/move-links/${r.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body.revokedAt).not.toBeNull();
    const again = await owner.client.call<Link>("DELETE", `/api/channels/${owner.username}/move-links/${r.body.id}`);
    expect(again.body.revokedAt).toBe(del.body.revokedAt);
    expect((await owner.client.call("DELETE", `/api/channels/${owner.username}/move-links/${uuidv7()}`)).status).toBe(
      404,
    );
    const res = await viewer.client.call<{ state: string }>("GET", `/api/move-links/${owner.username}/${r.body.nonce}`);
    expect(res.body.state).toBe("revoked");
    // Another channel's slug with this nonce is unknown, not revoked.
    const cross = await viewer.client.call<{ state: string; channel: null }>(
      "GET",
      `/api/move-links/${other.username}/${r.body.nonce}`,
    );
    expect(cross.body).toEqual({ state: "unknown", channel: null });
  });

  test(`at most ${MOVE_LINK_RULES.maxActive} active links, and ${MOVE_LINK_RULES.perDay} created per day`, async () => {
    const u = await signUpAndSignIn(api);
    const ids: string[] = [];
    for (let i = 0; i < MOVE_LINK_RULES.maxActive; i++) {
      const r = await createLink(u);
      expect(r.status).toBe(200);
      ids.push(r.body.id);
    }
    expect((await createLink(u)).status).toBe(409);
    // Revoking frees a slot; the day's count keeps counting revoked links.
    for (const id of ids) await u.client.call("DELETE", `/api/channels/${u.username}/move-links/${id}`);
    for (let i = MOVE_LINK_RULES.maxActive; i < MOVE_LINK_RULES.perDay; i++) {
      const r = await createLink(u);
      expect(r.status).toBe(200);
      await u.client.call("DELETE", `/api/channels/${u.username}/move-links/${r.body.id}`);
    }
    const limited = await createLink(u);
    expect(limited.status).toBe(429);
    expect((limited.body as unknown as { data: { retryAfterSeconds: number } }).data.retryAfterSeconds).toBeGreaterThan(
      0,
    );
  });
});

describe("attribution and conversions", () => {
  test("only a new follow through a live link of this channel is attributed", async () => {
    const streamer = await signUpAndSignIn(api);
    const ch = await channelOf(streamer);
    const live = (await createLink(streamer)).body;
    const revoked = (await createLink(streamer)).body;
    await streamer.client.call("DELETE", `/api/channels/${streamer.username}/move-links/${revoked.id}`);
    const foreign = (await createLink(other)).body;
    const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(() => signUpAndSignIn(api)));

    // A live link: attributed, and the trigger-kept count rises.
    const fa = await follow(a!, streamer.username, live.nonce);
    expect(fa.body).toEqual({ following: true, followerCount: 1 });
    expect(await followRow(a!.userId, ch.id)).toMatchObject({ source: "move_link", moveLinkId: live.id });
    // An existing follower through the link: nothing changes.
    await follow(b!, streamer.username);
    await follow(b!, streamer.username, live.nonce);
    expect(await followRow(b!.userId, ch.id)).toMatchObject({ source: "direct", moveLinkId: null });
    // A revoked link, and another channel's link: the visitor follows, unattributed.
    expect((await follow(c!, streamer.username, revoked.nonce)).body.following).toBe(true);
    expect(await followRow(c!.userId, ch.id)).toMatchObject({ source: "direct", moveLinkId: null });
    await follow(d!, streamer.username, foreign.nonce);
    expect(await followRow(d!.userId, ch.id)).toMatchObject({ source: "direct", moveLinkId: null });

    const conv = async () =>
      (await streamer.client.call<Link[]>("GET", `/api/channels/${streamer.username}/move-links`)).body.find(
        (l) => l.id === live.id,
      )?.conversions;
    expect(await conv()).toBe(1);

    // Integrity exclusion removes the conversion and the follower, both counted from non-excluded follows.
    const e = await signUpAndSignIn(api);
    await follow(e, streamer.username, live.nonce);
    expect(await conv()).toBe(2);
    const count = async () =>
      (
        await db()
          .select({ n: schema.channels.followerCount })
          .from(schema.channels)
          .where(eq(schema.channels.id, ch.id))
      )[0]?.n;
    expect(await count()).toBe(5);
    await db()
      .update(schema.follows)
      .set({ excludedAt: new Date() })
      .where(and(eq(schema.follows.followerId, e.userId), eq(schema.follows.channelId, ch.id)));
    expect(await conv()).toBe(1);
    expect(await count()).toBe(4);
  });
});

describe("grants", () => {
  test("a grant needs a follow; on, listed, off; another member never sees it", async () => {
    const streamer = await signUpAndSignIn(api);
    const u = await signUpAndSignIn(api);
    const set = (enabled: boolean) =>
      u.client.call<{ enabled: boolean }>("PUT", `/api/channels/${streamer.username}/portability-grant`, { enabled });
    expect((await set(true)).status).toBe(412);
    await follow(u, streamer.username);
    expect((await set(true)).body).toEqual({ enabled: true });
    expect((await set(true)).body).toEqual({ enabled: true });
    const mine = await u.client.call<{ channel: { slug: string } }[]>("GET", "/api/me/portability-grants");
    expect(mine.body.map((g) => g.channel.slug)).toEqual([streamer.username]);
    const theirs = await streamer.client.call<unknown[]>("GET", "/api/me/portability-grants");
    expect(theirs.body).toEqual([]);
    // The follow menu reads it from `channels.get` (orchestrator, batch 7 wave 1).
    const viewerOf = async () =>
      (await u.client.call<{ viewer: unknown }>("GET", `/api/channels/${streamer.username}`)).body.viewer;
    expect(await viewerOf()).toEqual({ following: true, portabilityGrant: true });
    expect((await set(false)).body).toEqual({ enabled: false });
    expect(await viewerOf()).toEqual({ following: true, portabilityGrant: false });
    expect((await u.client.call<unknown[]>("GET", "/api/me/portability-grants")).body).toEqual([]);
    expect(
      (await u.client.call("PUT", "/api/channels/nobody_here_x/portability-grant", { enabled: true })).status,
    ).toBe(404);
  });
});

describe("the moved unsubscribe list", () => {
  test("unsubscribing from `moved` withdraws every remaining grant; other lists keep them", async () => {
    const [s1, s2, u] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
    for (const s of [s1, s2]) {
      await follow(u, s.username);
      await u.client.call("PUT", `/api/channels/${s.username}/portability-grant`, { enabled: true });
    }
    const grants = async () =>
      (
        await db()
          .select()
          .from(schema.followPortabilityGrants)
          .where(eq(schema.followPortabilityGrants.userId, u.userId))
      ).length;
    expect(await grants()).toBe(2);
    const secret = api.deps.env.AUTH_SECRET;
    await applyUnsubscribe(api.db.db, secret, "go_live", await signUnsubscribeToken(secret, u.userId, "go_live"));
    expect(await grants()).toBe(2);
    await applyUnsubscribe(api.db.db, secret, "moved", await signUnsubscribeToken(secret, u.userId, "moved"));
    expect(await grants()).toBe(0);
  });
});

describe("move", () => {
  const moved = (u: User, movedTo: unknown) =>
    u.client.call<{ movedTo: string | null; movedAt: string | null }>("PUT", `/api/channels/${u.username}/moved-to`, {
      movedTo,
    });
  const movedEvents = async (channelId: string) =>
    db()
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.type, "channel.moved"), eq(schema.events.channelId, channelId)));

  test("only an https URL without credentials, up to 500 characters", async () => {
    const u = await signUpAndSignIn(api);
    for (const bad of [
      "http://example.org/me",
      "https://user:pw@example.org/me",
      "ftp://example.org",
      "not a url",
      "javascript:alert(1)",
      `https://example.org/${"a".repeat(500)}`,
    ])
      expect([bad.slice(0, 40), (await moved(u, bad)).status]).toEqual([bad.slice(0, 40), 400]);
    expect((await channelOf(u)).movedTo).toBeNull();
  });

  test("set writes moved_to and one channel.moved event; the same address again writes nothing; clear sends nothing", async () => {
    const u = await signUpAndSignIn(api);
    const ch = await channelOf(u);
    const r = await moved(u, "https://video.example.org/c/me");
    expect(r.status).toBe(200);
    expect(r.body.movedTo).toBe("https://video.example.org/c/me");
    expect(r.body.movedAt).not.toBeNull();
    expect(await movedEvents(ch.id)).toHaveLength(1);
    expect((await movedEvents(ch.id))[0]?.payload).toMatchObject({
      channel_id: ch.id,
      moved_to: "https://video.example.org/c/me",
    });
    await moved(u, "https://video.example.org/c/me");
    expect(await movedEvents(ch.id)).toHaveLength(1);
    const page = await viewer.client.call<{ movedTo: { url: string } | null }>("GET", `/api/channels/${u.username}`);
    expect(page.body.movedTo?.url).toBe("https://video.example.org/c/me");
    const cleared = await u.client.call<{ movedTo: null }>("DELETE", `/api/channels/${u.username}/moved-to`);
    expect(cleared.body).toEqual({ movedTo: null, movedAt: null });
    expect(await movedEvents(ch.id)).toHaveLength(1);
    expect((await moved(viewer, "https://x.example.org")).status).toBe(200); // their own channel
    expect(
      (await viewer.client.call("PUT", `/api/channels/${u.username}/moved-to`, { movedTo: "https://x.example.org" }))
        .status,
    ).toBe(403);
  });
});

describe("imports (the API half)", () => {
  const bucket = () => api.deps.env.S3_BUCKET_MEDIA;
  const upload = async (u: User) => {
    const r = await u.client.call<{ key: string; uploadUrl: string; headers: Record<string, string> }>(
      "POST",
      `/api/channels/${u.username}/imports/upload`,
      { sizeBytes: 4 },
    );
    expect(r.status).toBe(200);
    await api.deps.storage.put(bucket(), r.body.key, new Uint8Array([0x50, 0x4b, 3, 4]), {
      contentType: "application/zip",
    });
    return r.body.key;
  };

  test("upload presigns a key of the channel under incoming/; preview refuses another key", async () => {
    const u = await signUpAndSignIn(api);
    const ch = await channelOf(u);
    const r = await u.client.call<{ key: string; headers: Record<string, string> }>(
      "POST",
      `/api/channels/${u.username}/imports/upload`,
      { sizeBytes: 1234 },
    );
    expect(r.body.key).toMatch(new RegExp(`^incoming/portability/${ch.id}/[0-9a-f-]{36}\\.zip$`));
    expect(r.body.headers).toEqual({ "content-type": "application/zip", "content-length": "1234" });
    const foreign = `incoming/portability/${(await channelOf(other)).id}/${uuidv7()}.zip`;
    expect((await u.client.call("POST", `/api/channels/${u.username}/imports`, { key: foreign })).status).toBe(400);
    expect(
      (await viewer.client.call("POST", `/api/channels/${u.username}/imports/upload`, { sizeBytes: 1 })).status,
    ).toBe(403);
  });

  test("a preview the worker refuses answers 400 with the reason, and the import is failed", async () => {
    const u = await signUpAndSignIn(api);
    const key = await upload(u);
    previewBehaviour = async (id) => {
      await db()
        .update(schema.portabilityImports)
        .set({
          status: "failed",
          preview: { state: "refused", refusal: "standing_suspended" },
          result: [{ kind: "channel", ref: "channel", label: "", outcome: "rejected", reason: "standing_suspended" }],
        })
        .where(eq(schema.portabilityImports.id, id));
    };
    const r = await u.client.call<{ data: { reason: string } }>("POST", `/api/channels/${u.username}/imports`, { key });
    expect(r.status).toBe(400);
    expect(r.body.data.reason).toBe("standing_suspended");
    const list = await u.client.call<{ status: string; result: { reason: string }[] }[]>(
      "GET",
      `/api/channels/${u.username}/imports`,
    );
    expect(list.body[0]).toMatchObject({ status: "failed", result: [{ reason: "standing_suspended" }] });
    // The same upload cannot be previewed twice.
    expect((await u.client.call("POST", `/api/channels/${u.username}/imports`, { key })).status).toBe(409);
  });

  test("preview, then start: emotes need the rights assertion; the choices are stored and the job queued", async () => {
    const u = await signUpAndSignIn(api);
    const key = await upload(u);
    previewBehaviour = async (id) => {
      await db()
        .update(schema.portabilityImports)
        .set({
          standingVerified: true,
          standingIssuer: "https://old.example.org",
          preview: {
            state: "ready",
            channel: { title: "Hello" },
            items: [
              { kind: "channel", ref: "channel", label: "Hello", outcome: null, reason: null },
              { kind: "emote", ref: "wave", label: "wave", outcome: null, reason: null, key: "internal" },
            ],
            standing: { state: "verified" },
          },
        })
        .where(eq(schema.portabilityImports.id, id));
    };
    const p = await u.client.call<{
      id: string;
      status: string;
      standingVerified: boolean;
      preview: { channel: Record<string, unknown>; items: Record<string, unknown>[] };
    }>("POST", `/api/channels/${u.username}/imports`, { key });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ status: "previewed", standingVerified: true });
    expect(p.body.preview.channel).toMatchObject({ title: "Hello", state: "ready", standing: { state: "verified" } });
    // Internal fields never leave the API.
    expect(p.body.preview.items[1]).toEqual({ kind: "emote", ref: "wave", label: "wave", outcome: null, reason: null });

    const start = (body: Record<string, unknown>) =>
      u.client.call<{ status: string; assertedAt: string | null }>(
        "POST",
        `/api/channels/${u.username}/imports/${p.body.id}/start`,
        body,
      );
    const choices = { channel: true, panels: false, emotes: ["wave", "notInBundle"] };
    expect((await start({ choices })).status).toBe(412);
    const ok = await start({ choices, assertEmoteRights: true });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("queued");
    expect(ok.body.assertedAt).not.toBeNull();
    expect(started).toContain(p.body.id);
    const [row] = await db()
      .select()
      .from(schema.portabilityImports)
      .where(eq(schema.portabilityImports.id, p.body.id));
    expect(row?.choices).toEqual({ channel: true, panels: false, emotes: ["wave"] });
    expect(row?.assertionVersion).not.toBeNull();
    // Started once only.
    expect((await start({ choices, assertEmoteRights: true })).status).toBe(409);
    expect((await other.client.call("GET", `/api/channels/${u.username}/imports/${p.body.id}`)).status).toBe(403);
  });
});

describe("bundle export", () => {
  test("the owner requests a bundle export (cooldown shared with the export pipeline)", async () => {
    const u = await signUpAndSignIn(api);
    const r = await u.client.call<{ kind: string; status: string }>("POST", `/api/channels/${u.username}/bundle`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "bundle", status: "queued" });
    expect((await u.client.call("POST", `/api/channels/${u.username}/bundle`)).status).toBe(429);
    const [n] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.dataExports)
      .where(and(eq(schema.dataExports.userId, u.userId), eq(schema.dataExports.kind, "bundle")));
    expect(n?.n).toBe(1);
  });
});
