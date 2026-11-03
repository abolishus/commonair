// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N4-api against the real stack (ADR 0030): the flag off (404 and FORBIDDEN), turning a channel on
 * (its key, encrypted at rest), WebFinger, the actor (negotiation, mature, suspended, gone),
 * collections (followers: a count and no items; the outbox), NodeInfo (no usage counts), the inbox
 * (item and outbox event together, drop, blocked domain), domain blocks (followers dropped,
 * audited), key rotation (history, audit, the rotate job), turning off (the two internal events,
 * no delivery queued by the API, 410), the followers procedures, and that no route makes an outbound request.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { FEDERATION_JOBS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { publicKeyPemFromPrivate } from "@commonair/federation";
import { decryptSecret } from "@commonair/tokens";
import { FEDERATION_KEY_PURPOSE } from "../src/federation/keys.ts";
import { setFederationQueue } from "../src/federation/queue.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Settings {
  enabled: boolean;
  instanceEnabled: boolean;
  handle: string | null;
  actorId: string | null;
  followers: number;
}
interface Err {
  code: string;
  data?: { reason?: string };
}

let api: TestApi;
let streamer: Account;
let editor: Account;
let admin: Account;
let other: Account;
let plain: Account;
const channelIds: Record<string, string> = {};
const jobs: { kind: "rotate" | "deliver"; data: unknown; key: string }[] = [];
/** When set, the fake queue refuses deliver jobs to the inboxes it matches. */
let failDeliver: ((inbox: string) => boolean) | null = null;

const owner = () => api.db.db;
const host = () => new URL(api.url).host;
const actorOf = (id: string) => `${api.url}/ap/channels/${id}`;

beforeAll(async () => {
  api = await startApi({ env: { FEDERATION_ENABLED: "true" } });
  setFederationQueue(api.deps, {
    async rotate(channelId, rotationId) {
      jobs.push({ kind: "rotate", data: { channelId }, key: rotationId });
    },
    async deliver(job, key) {
      if (failDeliver?.(job.inbox)) throw new Error("queue down");
      jobs.push({ kind: "deliver", data: job, key });
    },
    async close() {},
  });
  const accounts = await Promise.all(Array.from({ length: 5 }, () => signUpAndSignIn(api)));
  [streamer, editor, admin, other, plain] = [accounts[0]!, accounts[1]!, accounts[2]!, accounts[3]!, accounts[4]!];
  for (const a of [streamer, other, plain]) {
    const [c] = await owner().select().from(schema.channels).where(eq(schema.channels.slug, a.username));
    channelIds[a.username] = c!.id;
  }
  await owner().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
  await owner()
    .insert(schema.channelRoles)
    .values({ channelId: channelIds[streamer.username]!, userId: editor.userId, role: "editor" });
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

/** The env is a plain object: flip a flag for one block. */
async function withEnv(patch: Record<string, unknown>, fn: () => Promise<void>) {
  const env = api.deps.env as unknown as Record<string, unknown>;
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, env[k]]));
  Object.assign(env, patch);
  try {
    await fn();
  } finally {
    Object.assign(env, before);
  }
}

const AP = "application/activity+json";
const get = (path: string, accept = AP) => fetch(`${api.url}${path}`, { headers: { accept }, redirect: "manual" });
const settingsPath = (slug: string) => `/api/channels/${slug}/federation`;
const enable = (a: Account, enabled: boolean) =>
  a.client.call<Settings & Err>("PATCH", settingsPath(a.username), { enabled });

function inboxPost(path: string, activity: Record<string, unknown>, headers: Record<string, string> = {}) {
  const actor = String(activity.actor);
  return fetch(`${api.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": AP,
      date: new Date().toUTCString(),
      digest: "SHA-256=AAAA",
      signature: `keyId="${actor}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="c2ln"`,
      ...headers,
    },
    body: JSON.stringify(activity),
  });
}

const follow = (actor: string, channelId: string) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `${actor}#follows/${crypto.randomUUID()}`,
  type: "Follow",
  actor,
  object: actorOf(channelId),
});

async function addFollower(channelId: string, actor: string, sharedInbox: string | null = null) {
  const u = new URL(actor);
  const [row] = await owner()
    .insert(schema.federationFollowers)
    .values({
      channelId,
      actorId: actor,
      inbox: `${actor}/inbox`,
      sharedInbox,
      handle: `@${u.pathname.split("/").pop()}@${u.hostname}`,
      domain: u.hostname,
    })
    .returning();
  return row!;
}

describe("flag off", () => {
  test("every raw route is 404 and every procedure FORBIDDEN (federation_disabled)", async () => {
    await withEnv({ FEDERATION_ENABLED: false }, async () => {
      const id = channelIds[streamer.username]!;
      for (const [method, path] of [
        ["GET", `/api/.well-known/webfinger?resource=acct:${streamer.username}@${host()}`],
        ["GET", "/api/.well-known/nodeinfo"],
        ["GET", "/api/nodeinfo/2.1"],
        ["GET", `/ap/channels/${id}`],
        ["GET", `/ap/channels/${id}/outbox`],
        ["GET", `/ap/channels/${id}/followers`],
        ["POST", `/ap/channels/${id}/inbox`],
        ["POST", "/ap/inbox"],
      ] as const)
        expect([(await fetch(`${api.url}${path}`, { method })).status, path]).toEqual([404, path]);

      const calls: [Account, string, string, unknown?][] = [
        [streamer, "GET", settingsPath(streamer.username)],
        [streamer, "PATCH", settingsPath(streamer.username), { enabled: true }],
        [streamer, "GET", `${settingsPath(streamer.username)}/followers`],
        [streamer, "DELETE", `${settingsPath(streamer.username)}/followers/${uuidv7()}`],
        [admin, "GET", "/api/admin/federation/blocks"],
        [admin, "POST", "/api/admin/federation/blocks", { domain: "x.example" }],
        [admin, "DELETE", "/api/admin/federation/blocks/x.example"],
        [admin, "POST", "/api/admin/federation/keys/rotate", {}],
      ];
      for (const [who, method, path, body] of calls) {
        const r = await who.client.call<Err>(method, path, body);
        expect([path, r.status, r.body.code, r.body.data?.reason]).toEqual([
          path,
          403,
          "FORBIDDEN",
          "federation_disabled",
        ]);
      }
      const info = await streamer.client.call<{ features: { federation: boolean } }>("GET", "/api/instance");
      expect(info.body.features.federation).toBe(false);
    });
    const info = await streamer.client.call<{ features: { federation: boolean } }>("GET", "/api/instance");
    expect(info.body.features.federation).toBe(true);
  });
});

describe("turning a channel on", () => {
  test("off by default; the editor may read but not change it", async () => {
    const r = await editor.client.call<Settings>("GET", settingsPath(streamer.username));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, instanceEnabled: true, handle: null, actorId: null, followers: 0 });
    const denied = await editor.client.call<Err>("PATCH", settingsPath(streamer.username), { enabled: true });
    expect([denied.status, denied.body.data?.reason]).toEqual([403, "owner_only"]);
    expect((await other.client.call("GET", settingsPath(streamer.username))).status).toBe(403);
  });

  test("creates the actor and its RSA key, the private key encrypted at rest", async () => {
    const id = channelIds[streamer.username]!;
    const r = await enable(streamer, true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      enabled: true,
      instanceEnabled: true,
      handle: `@${streamer.username}@${host()}`,
      actorId: actorOf(id),
      followers: 0,
    });
    const [actor] = await owner()
      .select()
      .from(schema.federationActors)
      .where(eq(schema.federationActors.channelId, id));
    expect(actor).toMatchObject({ enabled: true, keyId: `${actorOf(id)}#main-key` });
    expect(actor!.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(actor!.privateKeyEnc.startsWith("v1.")).toBe(true);
    expect(actor!.privateKeyEnc).not.toContain("PRIVATE KEY");
    const pem = await decryptSecret(api.deps.env.AUTH_SECRET, FEDERATION_KEY_PURPOSE, actor!.privateKeyEnc);
    expect(pem).toContain("BEGIN PRIVATE KEY");
    expect(await publicKeyPemFromPrivate(pem)).toBe(actor!.publicKeyPem);
    const [c] = await owner().select().from(schema.channels).where(eq(schema.channels.id, id));
    expect(c!.federationSettings.enabled).toBe(true);
    // Turning it on again keeps the key and writes no second audit row.
    await enable(streamer, true);
    const [again] = await owner()
      .select()
      .from(schema.federationActors)
      .where(eq(schema.federationActors.channelId, id));
    expect(again!.privateKeyEnc).toBe(actor!.privateKeyEnc);
    const audits = await owner()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "federation.channel.enable"), eq(schema.auditLog.subjectId, id)));
    expect(audits).toHaveLength(1);
  });
});

describe("discovery and documents", () => {
  test("WebFinger: acct and actor id resolve; other domains, unknown and unfederated channels are 404", async () => {
    const id = channelIds[streamer.username]!;
    const r = await get(`/api/.well-known/webfinger?resource=acct:${streamer.username.toUpperCase()}@${host()}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/jrd+json");
    const jrd = (await r.json()) as { subject: string; links: { rel: string; href: string }[] };
    expect(jrd.subject).toBe(`acct:${streamer.username}@${host()}`);
    expect(jrd.links.find((l) => l.rel === "self")?.href).toBe(actorOf(id));
    const byId = await get(`/api/.well-known/webfinger?resource=${encodeURIComponent(actorOf(id))}`);
    expect(byId.status).toBe(200);
    for (const resource of [
      `acct:${streamer.username}@other.example`,
      `acct:${plain.username}@${host()}`,
      `acct:nobody_here_x@${host()}`,
      `${api.url}/ap/channels/${uuidv7()}`,
      "",
    ])
      expect([
        resource,
        (await get(`/api/.well-known/webfinger?resource=${encodeURIComponent(resource)}`)).status,
      ]).toEqual([resource, 404]);
    expect((await get("/api/.well-known/webfinger")).status).toBe(404);
  });

  test("actor: the Service document for AP clients, 303 to the page for a browser", async () => {
    const id = channelIds[streamer.username]!;
    for (const accept of [AP, 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"']) {
      const r = await get(`/ap/channels/${id}`, accept);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain(AP);
      const doc = (await r.json()) as Record<string, unknown> & { publicKey: Record<string, string> };
      expect(doc).toMatchObject({
        id: actorOf(id),
        type: "Service",
        preferredUsername: streamer.username,
        inbox: `${actorOf(id)}/inbox`,
        endpoints: { sharedInbox: `${api.url}/ap/inbox` },
      });
      const [actor] = await owner()
        .select()
        .from(schema.federationActors)
        .where(eq(schema.federationActors.channelId, id));
      expect(doc.publicKey).toEqual({
        id: `${actorOf(id)}#main-key`,
        owner: actorOf(id),
        publicKeyPem: actor!.publicKeyPem,
      });
      expect(JSON.stringify(doc)).not.toContain(streamer.email);
    }
    const html = await get(`/ap/channels/${id}`, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
    expect(html.status).toBe(303);
    expect(html.headers.get("location")).toBe(`${api.url}/${streamer.username}`);
  });

  test("mature: no icon or image", async () => {
    const id = channelIds[streamer.username]!;
    await owner()
      .update(schema.channels)
      .set({ theme: { avatarKey: "avatars/a.png", bannerKey: "banners/b.png" } })
      .where(eq(schema.channels.id, id));
    const before = (await (await get(`/ap/channels/${id}`)).json()) as Record<string, { url: string }>;
    expect(before.icon?.url).toContain("avatars/a.png");
    expect(before.image?.url).toContain("banners/b.png");
    await owner().update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, id));
    const after = (await (await get(`/ap/channels/${id}`)).json()) as Record<string, unknown>;
    expect(after).not.toHaveProperty("icon");
    expect(after).not.toHaveProperty("image");
    await owner().update(schema.channels).set({ mature: false, theme: {} }).where(eq(schema.channels.id, id));
  });

  test("a non-federated or unknown channel is 404 on every document", async () => {
    for (const id of [channelIds[plain.username]!, uuidv7()])
      for (const sub of ["", "/outbox", "/followers"]) expect((await get(`/ap/channels/${id}${sub}`)).status).toBe(404);
  });

  test("followers: a count and no items", async () => {
    const id = channelIds[streamer.username]!;
    await addFollower(id, "https://masto.example/users/ann", "https://masto.example/inbox");
    await addFollower(id, "https://other.example/users/bob");
    const r = await get(`/ap/channels/${id}/followers`);
    expect(r.status).toBe(200);
    const doc = (await r.json()) as Record<string, unknown>;
    expect(doc).toEqual({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorOf(id)}/followers`,
      type: "OrderedCollection",
      totalItems: 2,
    });
    expect(JSON.stringify(doc)).not.toContain("masto.example");
    // Paging parameters change nothing.
    const paged = (await (await get(`/ap/channels/${id}/followers?page=true`)).json()) as Record<string, unknown>;
    expect(paged).not.toHaveProperty("orderedItems");
    expect(paged).not.toHaveProperty("items");
    expect(paged).not.toHaveProperty("first");
  });

  test("outbox: live objects newest first, paged, each linking its stable id", async () => {
    const id = channelIds[streamer.username]!;
    const base = Date.parse("2026-10-01T00:00:00.000Z");
    const rows = Array.from({ length: 22 }, (_, i) => ({
      id: uuidv7(base + i * 1000),
      channelId: id,
      kind: "video" as const,
      subjectKind: "vod" as const,
      subjectId: uuidv7(),
      publishedAt: new Date(base + i * 1000),
      deletedAt: i === 21 ? new Date(base + 30_000) : null,
    }));
    await owner().insert(schema.federationObjects).values(rows);
    const top = (await (await get(`/ap/channels/${id}/outbox`)).json()) as { totalItems: number; first: string };
    expect(top.totalItems).toBe(21);
    const first = (await (await fetch(top.first, { headers: { accept: AP } })).json()) as {
      type: string;
      orderedItems: { id: string; type: string; actor: string; object: string; published: string }[];
      next?: string;
    };
    expect(first.type).toBe("OrderedCollectionPage");
    expect(first.orderedItems).toHaveLength(20);
    // The deleted newest one (index 21) is left out; index 20 leads.
    expect(first.orderedItems[0]).toMatchObject({
      id: `${api.url}/ap/objects/${rows[20]!.id}/activity`,
      type: "Create",
      actor: actorOf(id),
      object: `${api.url}/ap/objects/${rows[20]!.id}`,
      published: rows[20]!.publishedAt.toISOString(),
    });
    expect(first.next).toBeDefined();
    const second = (await (await fetch(first.next!, { headers: { accept: AP } })).json()) as {
      orderedItems: { object: string }[];
      next?: string;
    };
    expect(second.orderedItems.map((o) => o.object)).toEqual([`${api.url}/ap/objects/${rows[0]!.id}`]);
    expect(second.next).toBeUndefined();
  });

  test("outbox paging skips nothing when objects share a millisecond", async () => {
    const a = await signUpAndSignIn(api);
    expect((await enable(a, true)).status).toBe(200);
    const [c] = await owner().select().from(schema.channels).where(eq(schema.channels.slug, a.username));
    const rows = Array.from({ length: 23 }, () => ({
      id: uuidv7(),
      channelId: c!.id,
      kind: "video" as const,
      subjectKind: "vod" as const,
      subjectId: uuidv7(),
    }));
    await owner().insert(schema.federationObjects).values(rows);
    // One millisecond, 23 different microseconds; ids in the opposite order to the times.
    for (const [i, r] of rows.entries())
      await owner().execute(
        sql`update federation_objects set published_at = ${`2026-10-02T00:00:00.000${String(900 - i * 30).padStart(3, "0")}Z`}::timestamptz where id = ${r.id}`,
      );
    const seen: string[] = [];
    let next: string | undefined = `${api.url}/ap/channels/${c!.id}/outbox?page=true`;
    while (next) {
      const page = (await (await fetch(next, { headers: { accept: AP } })).json()) as {
        orderedItems: { object: string }[];
        next?: string;
      };
      seen.push(...page.orderedItems.map((o) => o.object));
      next = page.next;
    }
    expect(seen.sort()).toEqual(rows.map((r) => `${api.url}/ap/objects/${r.id}`).sort());
  });

  test("NodeInfo: links to 2.1; no usage counts", async () => {
    const links = (await (await get("/api/.well-known/nodeinfo", "application/json")).json()) as {
      links: { rel: string; href: string }[];
    };
    expect(links.links[0]!.href).toBe(`${api.url}/nodeinfo/2.1`);
    const r = await get("/api/nodeinfo/2.1", "application/json");
    expect(r.status).toBe(200);
    const doc = (await r.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({ version: "2.1", protocols: ["activitypub"], openRegistrations: true });
    expect(doc.usage).toEqual({ users: {} });
  });
});

describe("inbox", () => {
  test("a Follow is stored with its outbox event, in one transaction, and answered 202", async () => {
    const id = channelIds[streamer.username]!;
    const activity = follow("https://masto.example/users/carol", id);
    const r = await inboxPost(`/ap/channels/${id}/inbox`, activity);
    expect(r.status).toBe(202);
    const items = await owner()
      .select()
      .from(schema.federationInboxItems)
      .where(eq(schema.federationInboxItems.channelId, id));
    const item = items.find((i) => JSON.parse(i.body).id === activity.id);
    expect(item).toBeDefined();
    expect(item!.headers["(request-target)"]).toBe(`post /ap/channels/${id}/inbox`);
    expect(item!.headers.signature).toContain("keyId=");
    expect(item!.processedAt).toBeNull();
    const events = await owner()
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, "federation.inbox.received"));
    const ev = events.find((e) => (e.payload as { item_id: string }).item_id === item!.id);
    expect(ev).toBeDefined();
    expect(ev!.channelId).toBe(id);
    expect(ev!.occurredAt.getTime()).toBe(item!.receivedAt.getTime());
  });

  test("the shared inbox stores items with no channel", async () => {
    const activity = { ...follow("https://masto.example/users/dan", channelIds[streamer.username]!), type: "Delete" };
    expect((await inboxPost("/ap/inbox", activity)).status).toBe(202);
    const items = await owner().select().from(schema.federationInboxItems);
    const item = items.find((i) => JSON.parse(i.body).id === activity.id);
    expect(item?.channelId).toBeNull();
  });

  test("other types are 202 and dropped unstored", async () => {
    const before = (await owner().select().from(schema.federationInboxItems)).length;
    const create = { ...follow("https://masto.example/users/eve", channelIds[streamer.username]!), type: "Create" };
    expect((await inboxPost("/ap/inbox", create)).status).toBe(202);
    expect((await owner().select().from(schema.federationInboxItems)).length).toBe(before);
  });

  test("refusals are 4xx and store nothing; a non-federated channel's inbox is 404", async () => {
    const id = channelIds[streamer.username]!;
    const before = (await owner().select().from(schema.federationInboxItems)).length;
    const a = follow("https://masto.example/users/fay", id);
    expect((await inboxPost(`/ap/channels/${id}/inbox`, a, { "content-type": "application/json" })).status).toBe(415);
    expect((await inboxPost(`/ap/channels/${id}/inbox`, a, { signature: "" })).status).toBe(401);
    expect((await inboxPost(`/ap/channels/${id}/inbox`, a, { date: "yesterday" })).status).toBe(401);
    expect((await inboxPost(`/ap/channels/${id}/inbox`, { ...a, pad: "x".repeat(270_000) })).status).toBe(413);
    expect((await inboxPost(`/ap/channels/${channelIds[plain.username]!}/inbox`, a)).status).toBe(404);
    expect((await owner().select().from(schema.federationInboxItems)).length).toBe(before);
  });
});

describe("domain blocks (admin)", () => {
  test("add drops that domain's followers, refuses its inbox, and is audited; remove too", async () => {
    const id = channelIds[streamer.username]!;
    const keep = await addFollower(id, "https://fine.example/users/gil");
    await addFollower(id, "https://blocked.example/users/hal");
    await addFollower(id, "https://sub.blocked.example/users/ida");
    const lookalike = await addFollower(id, "https://notblocked.example/users/jo");

    expect(
      (await streamer.client.call("POST", "/api/admin/federation/blocks", { domain: "blocked.example" })).status,
    ).toBe(403);
    const r = await admin.client.call<{ domain: string; createdBy: { id: string } }>(
      "POST",
      "/api/admin/federation/blocks",
      { domain: "blocked.example" },
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ domain: "blocked.example", createdBy: { id: admin.userId } });
    const left = await owner()
      .select({ domain: schema.federationFollowers.domain })
      .from(schema.federationFollowers)
      .where(eq(schema.federationFollowers.channelId, id));
    expect(left.map((f) => f.domain)).not.toContain("blocked.example");
    expect(left.map((f) => f.domain)).not.toContain("sub.blocked.example");
    expect(left.map((f) => f.domain)).toEqual(expect.arrayContaining([keep.domain, lookalike.domain]));

    const [row] = await owner()
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, "federation.domain.block"), eq(schema.auditLog.subjectId, "blocked.example")),
      );
    expect(row).toMatchObject({ actorType: "admin", actorId: admin.userId, details: { followersDropped: 2 } });

    // Again: idempotent, no second audit row.
    expect(
      (await admin.client.call("POST", "/api/admin/federation/blocks", { domain: "blocked.example" })).status,
    ).toBe(200);
    const rows = await owner()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "federation.domain.block"));
    expect(rows).toHaveLength(1);

    const list = await admin.client.call<{ domain: string }[]>("GET", "/api/admin/federation/blocks");
    expect(list.body.map((b) => b.domain)).toEqual(["blocked.example"]);

    // The inbox refuses the domain and its subdomains.
    for (const actor of ["https://blocked.example/users/x", "https://deep.sub.blocked.example/users/y"])
      expect((await inboxPost("/ap/inbox", follow(actor, id))).status).toBe(403);

    expect((await admin.client.call("DELETE", "/api/admin/federation/blocks/blocked.example")).status).toBe(200);
    expect((await admin.client.call("DELETE", "/api/admin/federation/blocks/blocked.example")).status).toBe(404);
    const [unblock] = await owner()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "federation.domain.unblock"));
    expect(unblock).toMatchObject({ actorId: admin.userId, subjectId: "blocked.example" });
    expect((await inboxPost("/ap/inbox", follow("https://blocked.example/users/x", id))).status).toBe(202);
  });
});

describe("key rotation (admin)", () => {
  test("stores a new key, appends the old one, audits and queues the rotate job", async () => {
    const id = channelIds[streamer.username]!;
    const [old] = await owner().select().from(schema.federationActors).where(eq(schema.federationActors.channelId, id));
    expect((await streamer.client.call("POST", "/api/admin/federation/keys/rotate", {})).status).toBe(403);
    const r = await admin.client.call<{ rotated: number }>("POST", "/api/admin/federation/keys/rotate", {
      channel: streamer.username,
    });
    expect(r.body).toEqual({ rotated: 1 });
    const [now] = await owner().select().from(schema.federationActors).where(eq(schema.federationActors.channelId, id));
    expect(now!.publicKeyPem).not.toBe(old!.publicKeyPem);
    expect(now!.privateKeyEnc).not.toBe(old!.privateKeyEnc);
    expect(now!.keyId).toBe(old!.keyId);
    const history = await owner()
      .select()
      .from(schema.federationActorKeys)
      .where(eq(schema.federationActorKeys.channelId, id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ keyId: old!.keyId, publicKeyPem: old!.publicKeyPem });
    const audits = await owner()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "federation.key.rotate"), eq(schema.auditLog.subjectId, id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "admin", actorId: admin.userId, channelId: id });
    expect(jobs.filter((j) => j.kind === "rotate").map((j) => j.data)).toEqual([{ channelId: id }]);
    // The actor document serves the new key.
    const doc = (await (await get(`/ap/channels/${id}`)).json()) as { publicKey: { publicKeyPem: string } };
    expect(doc.publicKey.publicKeyPem).toBe(now!.publicKeyPem);

    // A channel that never federated rotates nothing; an unknown slug is 404.
    const none = await admin.client.call<{ rotated: number }>("POST", "/api/admin/federation/keys/rotate", {
      channel: plain.username,
    });
    expect(none.body).toEqual({ rotated: 0 });
    expect(
      (await admin.client.call("POST", "/api/admin/federation/keys/rotate", { channel: "no_such_slug" })).status,
    ).toBe(404);
    // All actors.
    const all = await admin.client.call<{ rotated: number }>("POST", "/api/admin/federation/keys/rotate", {});
    const actors = await owner()
      .select()
      .from(schema.federationActors)
      .where(eq(schema.federationActors.enabled, true));
    expect(all.body.rotated).toBe(actors.length);
  });
});

describe("followers procedures (owner)", () => {
  test("list shows handle and server to the owner only; remove deletes the row", async () => {
    const id = channelIds[streamer.username]!;
    const f = await addFollower(id, "https://masto.example/users/kim");
    const list = await streamer.client.call<{ items: { id: string; handle: string; domain: string; actor: string }[] }>(
      "GET",
      `${settingsPath(streamer.username)}/followers?limit=2`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ id: f.id, handle: "@kim@masto.example", domain: "masto.example" });
    expect((await editor.client.call("GET", `${settingsPath(streamer.username)}/followers`)).status).toBe(403);
    expect((await editor.client.call("DELETE", `${settingsPath(streamer.username)}/followers/${f.id}`)).status).toBe(
      403,
    );
    expect((await streamer.client.call("DELETE", `${settingsPath(streamer.username)}/followers/${f.id}`)).status).toBe(
      200,
    );
    expect((await streamer.client.call("DELETE", `${settingsPath(streamer.username)}/followers/${f.id}`)).status).toBe(
      404,
    );
    // Paging walks the rest, including rows that share a millisecond.
    for (const [i, name] of ["ana", "bo", "cy"].entries()) {
      const extra = await addFollower(id, `https://masto.example/users/${name}`);
      await owner().execute(
        sql`update federation_followers set created_at = ${`2026-10-03T00:00:00.000${100 + i * 300}Z`}::timestamptz where id = ${extra.id}`,
      );
    }
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page = await streamer.client.call<{ items: { id: string }[]; nextCursor: string | null }>(
        "GET",
        `${settingsPath(streamer.username)}/followers?limit=1${q}`,
      );
      all.push(...page.body.items.map((i) => i.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    const rows = await owner()
      .select()
      .from(schema.federationFollowers)
      .where(eq(schema.federationFollowers.channelId, id));
    expect(all.sort()).toEqual(rows.map((r) => r.id).sort());
  });
});

describe("suspension and turning off", () => {
  test("a suspended channel cannot turn on; once federated, suspension makes it gone", async () => {
    const id = channelIds[other.username]!;
    await owner().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, id));
    const refused = await enable(other, true);
    expect([refused.status, refused.body.data?.reason]).toEqual([403, "channel_suspended"]);
    // Never federated: 404.
    expect((await get(`/ap/channels/${id}`)).status).toBe(404);
    await owner().update(schema.channels).set({ suspendedAt: null }).where(eq(schema.channels.id, id));
    expect((await enable(other, true)).status).toBe(200);
    expect((await get(`/ap/channels/${id}`)).status).toBe(200);
    await owner().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, id));
    expect((await get(`/ap/channels/${id}`)).status).toBe(410);
    expect((await get(`/ap/channels/${id}/outbox`)).status).toBe(410);
    expect(
      (await get(`/api/.well-known/webfinger?resource=acct:${other.username}@${host()}`, "application/json")).status,
    ).toBe(404);
    // An owner ban suspends the channel too.
    await owner().update(schema.channels).set({ suspendedAt: null }).where(eq(schema.channels.id, id));
    expect((await get(`/ap/channels/${id}`)).status).toBe(200);
    await owner().update(schema.users).set({ banned: true }).where(eq(schema.users.id, other.userId));
    expect((await get(`/ap/channels/${id}`)).status).toBe(410);
    await owner().update(schema.users).set({ banned: false }).where(eq(schema.users.id, other.userId));
  });

  /** The outbox rows about this channel since `since` (type and payload), by type: one change shares a time. */
  const eventsSince = async (id: string, since: Date) =>
    (
      await owner()
        .select({ type: schema.events.type, payload: schema.events.payload })
        .from(schema.events)
        .where(
          and(eq(schema.events.channelId, id), sql`${schema.events.occurredAt} >= ${since.toISOString()}::timestamptz`),
        )
        .orderBy(schema.events.type)
    ).map((e) => [e.type, e.payload]);

  test("off: keeps the key, writes the two internal events for the worker, queues nothing, answers 410", async () => {
    const id = channelIds[streamer.username]!;
    await owner().delete(schema.federationFollowers).where(eq(schema.federationFollowers.channelId, id));
    await addFollower(id, "https://masto.example/users/lee", "https://masto.example/inbox");
    await addFollower(id, "https://masto.example/users/max", "https://masto.example/inbox");
    await addFollower(id, "https://solo.example/users/ned");
    const [before] = await owner()
      .select()
      .from(schema.federationActors)
      .where(eq(schema.federationActors.channelId, id));
    jobs.length = 0;
    const since = new Date(Date.now() - 1);

    const r = await enable(streamer, false);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: false, instanceEnabled: true, handle: null, actorId: null });

    // Batch 8 decision (h): the API queues no delivery; the outbox relay does, from these events.
    expect(jobs.filter((j) => j.kind === "deliver")).toEqual([]);
    expect(FEDERATION_JOBS.deliver).toBe("federation-deliver");
    expect(await eventsSince(id, since)).toEqual([
      ["channel.federation", { channel_id: id, enabled: false }],
      ["federation.actor.disabled", { channel_id: id }],
    ]);
    // Never the public `channel.update`.
    expect((await eventsSince(id, since)).some(([type]) => type === "channel.update")).toBe(false);
    // The follower rows wait for the worker's cleanup, which runs after their `Delete` is queued.
    expect(
      await owner().select().from(schema.federationFollowers).where(eq(schema.federationFollowers.channelId, id)),
    ).toHaveLength(3);

    const [after] = await owner()
      .select()
      .from(schema.federationActors)
      .where(eq(schema.federationActors.channelId, id));
    expect(after).toMatchObject({ enabled: false, privateKeyEnc: before!.privateKeyEnc });
    expect((await get(`/ap/channels/${id}`)).status).toBe(410);
    expect((await inboxPost(`/ap/channels/${id}/inbox`, follow("https://masto.example/users/o", id))).status).toBe(410);
    expect(
      (await get(`/api/.well-known/webfinger?resource=acct:${streamer.username}@${host()}`, "application/json")).status,
    ).toBe(404);
    const [audit] = await owner()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "federation.channel.disable"), eq(schema.auditLog.subjectId, id)))
      .orderBy(sql`${schema.auditLog.createdAt} desc`)
      .limit(1);
    expect(audit).toMatchObject({ actorId: streamer.userId, details: { followers: 3 } });

    // Turning it off again writes and queues nothing more.
    jobs.length = 0;
    const again = new Date(Date.now() - 1);
    expect((await enable(streamer, false)).status).toBe(200);
    expect(jobs).toHaveLength(0);
    expect(await eventsSince(id, again)).toEqual([]);
    // And back on: the same key, 200 again, and `channel.federation {enabled: true}` (no jobs).
    const on = new Date(Date.now() - 1);
    expect((await enable(streamer, true)).body.enabled).toBe(true);
    expect(await eventsSince(id, on)).toEqual([["channel.federation", { channel_id: id, enabled: true }]]);
    expect(jobs).toHaveLength(0);
    const [back] = await owner()
      .select()
      .from(schema.federationActors)
      .where(eq(schema.federationActors.channelId, id));
    expect(back!.privateKeyEnc).toBe(before!.privateKeyEnc);
    expect((await get(`/ap/channels/${id}`)).status).toBe(200);
  });

  test("off: the events commit with the setting, so a queue outage loses nothing", async () => {
    const id = channelIds[streamer.username]!;
    await owner().delete(schema.federationFollowers).where(eq(schema.federationFollowers.channelId, id));
    expect((await enable(streamer, true)).status).toBe(200);
    await addFollower(id, "https://down.example/users/kept");
    jobs.length = 0;
    const since = new Date(Date.now() - 1);
    failDeliver = () => true;
    try {
      expect((await enable(streamer, false)).status).toBe(200);
    } finally {
      failDeliver = null;
    }
    expect(jobs).toEqual([]);
    expect((await eventsSince(id, since)).map(([type]) => type)).toEqual([
      "channel.federation",
      "federation.actor.disabled",
    ]);
    expect((await enable(streamer, true)).status).toBe(200);
  });
});

describe("rate limits", () => {
  test("federation GETs are limited per address: 429 with retry-after", async () => {
    const limits = api.deps.rateLimits;
    const saved = limits.default;
    // Five times the default bucket: 5 per window here.
    limits.default = { max: 1, windowMs: 60_000 };
    try {
      const statuses: number[] = [];
      let last: Response | null = null;
      for (let i = 0; i < 6; i++) {
        last = await get(`/api/.well-known/webfinger?resource=acct:nobody_here_x@${host()}`);
        statuses.push(last.status);
      }
      expect(statuses.at(-1)).toBe(429);
      expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      limits.default = saved;
    }
  });
});

describe("no outbound requests", () => {
  test("every federation route answers with fetch, pinnedGet and DNS all throwing", async () => {
    const id = channelIds[streamer.username]!;
    const outbound: string[] = [];
    const realFetch = globalThis.fetch;
    const deps = api.deps as { pinnedGet: unknown; resolveHost: unknown };
    const saved = { pinnedGet: deps.pinnedGet, resolveHost: deps.resolveHost };
    const guarded = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(api.url)) {
          outbound.push(url);
          throw new Error(`outbound fetch to ${url}`);
        }
        return realFetch(input, init);
      },
      { preconnect: realFetch.preconnect },
    ) as typeof fetch;
    globalThis.fetch = guarded;
    deps.pinnedGet = async () => {
      outbound.push("pinnedGet");
      throw new Error("pinnedGet");
    };
    deps.resolveHost = async () => {
      outbound.push("resolveHost");
      throw new Error("resolveHost");
    };
    try {
      const statuses = [
        (await get(`/api/.well-known/webfinger?resource=acct:${streamer.username}@${host()}`)).status,
        (await get("/api/.well-known/nodeinfo")).status,
        (await get("/api/nodeinfo/2.1")).status,
        (await get(`/ap/channels/${id}`)).status,
        (await get(`/ap/channels/${id}/outbox?page=true`)).status,
        (await get(`/ap/channels/${id}/followers`)).status,
        (await inboxPost(`/ap/channels/${id}/inbox`, follow("https://remote.example/users/p", id))).status,
        (await inboxPost("/ap/inbox", follow("https://remote.example/users/q", id))).status,
      ];
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 202, 202]);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(deps, saved);
    }
    expect(outbound).toEqual([]);
  });
});
