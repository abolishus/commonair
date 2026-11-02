// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N4-delivery against real Postgres and Valkey, with the in-harness ActivityPub peer
 * (`harness/src/mocks/activitypub/peer.ts`) as the remote server on 127.0.0.1: inbox
 * verification and application, the fan-out's activities, signed delivery with backoff, the 7-day
 * drop, key rotation, the flags, the SSRF guard and account deletion's `Delete`.
 *
 * Inbox items are stored the way the API's front door stores them (raw headers and body, the
 * request signed for `https://air.example/ap/...`). Deliveries are queued by the code under test
 * and run here one by one (`drain`); the peer verifies each signature with the instance key.
 */
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { FEDERATION_JOBS, type FederationDeliverJob } from "@commonair/contracts/internal";
import { vodPrefix } from "@commonair/contracts/storage";
import { actorUrls, generateActorKey, objectUrl } from "@commonair/federation";
import { createLogger } from "@commonair/observability";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { encryptSecret } from "@commonair/tokens";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  type ActivityPubPeer,
  type ReceivedActivity,
  startActivityPubPeer,
} from "../../../harness/src/mocks/activitypub/peer.ts";
import type { EnqueueOptions } from "../src/context.ts";
import { captureRetiredActor, deleteFederationData, sendRetiredActorDelete } from "../src/deletion/federation.ts";
import { FEDERATION_KEY_PURPOSE, type FederationConfig } from "../src/federation/config.ts";
import { runDeliver } from "../src/federation/deliver.ts";
import { runFanout } from "../src/federation/fanout.ts";
import { InboxRetry, inboxPath, runInbox } from "../src/federation/inbox.ts";
import { remoteKeyCacheKey } from "../src/federation/remote.ts";
import { runRotate } from "../src/federation/rotate.ts";
import { runSweep } from "../src/federation/sweep.ts";
import { AUTH_SECRET, broadcasterFields, insertEvent, makeBroadcast, makeUser, VALKEY_URL } from "./fixtures.ts";

const ORIGIN = "https://air.example";
const DAY = 86_400_000;
const BACKOFF = [40, 40, 40, 40] as const;

const logger = createLogger({ service: "worker-test-federation", level: "fatal" });

let t: TestDatabase;
let owner: Database;
let valkey: ValkeyClient;
let peer: ActivityPubPeer;
let other: ActivityPubPeer;
/** Instance keys by keyId, including retired and account-deleted ones (the peer's key lookup). */
const knownKeys = new Map<string, string>();
const queued: { name: string; data: unknown; opts?: EnqueueOptions }[] = [];
let clock: () => Date = () => new Date();

const cfg = (over: Partial<FederationConfig> = {}): FederationConfig => ({
  enabled: true,
  allowInsecure: true,
  authSecret: AUTH_SECRET,
  site: { publicUrl: ORIGIN, defaultLocale: "en" },
  mediaBase: "https://media.air.example/media/",
  inboxHosts: new Set(["air.example"]),
  timeoutMs: 3_000,
  maxResponseBytes: 64 * 1024,
  backoffMs: BACKOFF,
  maxAttempts: 5,
  ...over,
});

const ctx = () => ({
  db: t.app.db,
  valkey,
  logger,
  now: () => clock(),
  enqueue: async (_q: string, name: string, data: unknown, opts?: EnqueueOptions) => {
    queued.push({ name, data, ...(opts ? { opts } : {}) });
  },
  enqueueBulk: async (_q: string, jobs: readonly { name: string; data: unknown; opts?: EnqueueOptions }[]) => {
    queued.push(...jobs);
  },
});

/** Run every queued delivery not yet run (attempt 1 and retries alike), in order. */
async function drain(c: FederationConfig = cfg()) {
  const results = [];
  while (queued.length > 0) {
    const job = queued.shift();
    if (!job || job.name !== FEDERATION_JOBS.deliver) continue;
    results.push(await runDeliver(job.data as FederationDeliverJob, ctx(), c));
  }
  return results;
}

beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
  valkey = createValkey(VALKEY_URL, { keyPrefix: `test:${crypto.randomUUID()}:`, name: "worker-test-federation" });
  const resolveKey = async (keyId: string) => {
    const [row] = await owner
      .select({ pem: schema.federationActors.publicKeyPem })
      .from(schema.federationActors)
      .where(eq(schema.federationActors.keyId, keyId));
    const pem = row?.pem ?? knownKeys.get(keyId);
    return pem ? { publicKeyPem: pem, owner: keyId.split("#")[0] ?? keyId } : null;
  };
  peer = await startActivityPubPeer({ host: "127.0.0.1", resolveKey });
  other = await startActivityPubPeer({ host: "127.0.0.1", username: "mallory", resolveKey });
}, 120_000);

afterAll(async () => {
  await peer?.close();
  await other?.close();
  await valkey?.quit();
  await t?.drop();
});

beforeEach(() => {
  queued.length = 0;
  clock = () => new Date();
});

// ------------------------------------------------------------ fixtures

/** A streamer whose channel federates (setting on, actor with an encrypted RSA-2048 key). */
async function federatedChannel(opts: { mature?: boolean; enabled?: boolean } = {}) {
  const s = await makeUser(owner);
  await owner
    .update(schema.channels)
    .set({ federationSettings: { enabled: opts.enabled ?? true }, mature: opts.mature ?? false })
    .where(eq(schema.channels.id, s.channel.id));
  const pair = await generateActorKey();
  const urls = actorUrls(ORIGIN, s.channel.id);
  await owner.insert(schema.federationActors).values({
    channelId: s.channel.id,
    enabled: opts.enabled ?? true,
    keyId: urls.keyId,
    publicKeyPem: pair.publicKeyPem,
    privateKeyEnc: await encryptSecret(AUTH_SECRET, FEDERATION_KEY_PURPOSE, pair.privateKeyPem),
  });
  knownKeys.set(urls.keyId, pair.publicKeyPem);
  return { ...s, urls, pair };
}

/** The peer as a follower of the channel, as the inbox stores it. */
async function addFollower(channelId: string, p: ActivityPubPeer = peer) {
  await owner.insert(schema.federationFollowers).values({
    id: uuidv7(),
    channelId,
    actorId: p.actorId,
    inbox: p.inbox,
    sharedInbox: p.sharedInbox,
    handle: `@${p.actorId.split("/").pop()}@127.0.0.1`,
    domain: "127.0.0.1",
  });
}

const followers = (channelId: string) =>
  owner.select().from(schema.federationFollowers).where(eq(schema.federationFollowers.channelId, channelId));

/** Store an inbox item as the API does: the request signed for this instance's public URL. */
async function inboxItem(
  channelId: string | null,
  activity: Record<string, unknown>,
  opts: Parameters<ActivityPubPeer["sign"]>[2] & { from?: ActivityPubPeer } = {},
) {
  const from = opts.from ?? peer;
  const signed = await from.sign(`${ORIGIN}${inboxPath(channelId)}`, activity, opts);
  const [row] = await owner
    .insert(schema.federationInboxItems)
    .values({ id: uuidv7(), channelId, headers: signed.headers, body: signed.body })
    .returning();
  return row!;
}

const followOf = (p: ActivityPubPeer, target: string) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `${p.origin}/${crypto.randomUUID()}`,
  type: "Follow",
  actor: p.actorId,
  object: target,
});

const deliveredTo = (from: number, type: string, objectType?: string) =>
  peer.since(from, (r) => r.type === type && (objectType === undefined || r.objectType === objectType));
const verifiedOk = (r: ReceivedActivity | undefined) => r?.verified.ok === true;

// ------------------------------------------------------------ inbox

describe("inbox", () => {
  test("a signed Follow verifies, stores the follower and sends a signed Accept", async () => {
    const ch = await federatedChannel();
    const follow = followOf(peer, ch.urls.id);
    const item = await inboxItem(ch.channel.id, follow);
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "accepted", reason: "follow" });

    const [f] = await followers(ch.channel.id);
    expect(f).toMatchObject({
      actorId: peer.actorId,
      inbox: peer.inbox,
      sharedInbox: peer.sharedInbox,
      handle: "@alice@127.0.0.1",
      domain: "127.0.0.1",
    });
    const [row] = await owner
      .select()
      .from(schema.federationInboxItems)
      .where(eq(schema.federationInboxItems.id, item.id));
    expect(row?.outcome).toBe("accepted");
    expect(row?.processedAt).not.toBeNull();

    // The Accept goes to the follower's own inbox, signed by the channel actor.
    expect(queued).toHaveLength(1);
    expect((queued[0]!.data as FederationDeliverJob).inbox).toBe(peer.inbox);
    const from = peer.received.length;
    expect(await drain()).toEqual([{ outcome: "delivered", status: 202 }]);
    const [accept] = deliveredTo(from, "Accept", "Follow");
    expect(verifiedOk(accept)).toBe(true);
    expect(accept?.headers.signature).toContain(`keyId="${ch.urls.keyId}"`);
    expect(accept?.json?.object).toMatchObject({ id: follow.id, actor: peer.actorId, object: ch.urls.id });

    // Processed once: a re-run changes nothing.
    expect((await runInbox(item.id, ctx(), cfg())).reason).toBe("already_processed");
  });

  test("a bad signature is dropped", async () => {
    const ch = await federatedChannel();
    const item = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id), { tamper: true });
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "rejected", reason: "digest_mismatch" });
    expect(await followers(ch.channel.id)).toEqual([]);
    expect(queued).toEqual([]);
  });

  test("a skewed date is dropped", async () => {
    const ch = await federatedChannel();
    const item = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id), {
      date: new Date(Date.now() - 13 * 3_600_000),
    });
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "rejected", reason: "date_skew" });
    expect(await followers(ch.channel.id)).toEqual([]);
  });

  test("a keyId that is not the actor's is dropped", async () => {
    const ch = await federatedChannel();
    // Signed by mallory's key, claiming to be alice.
    const signed = await other.sign(`${ORIGIN}${inboxPath(ch.channel.id)}`, followOf(peer, ch.urls.id));
    const [item] = await owner
      .insert(schema.federationInboxItems)
      .values({ id: uuidv7(), channelId: ch.channel.id, headers: signed.headers, body: signed.body })
      .returning();
    expect(await runInbox(item!.id, ctx(), cfg())).toEqual({ outcome: "rejected", reason: "key_actor_mismatch" });
    expect(await followers(ch.channel.id)).toEqual([]);
  });

  test("a stale cached key is refetched once, then verification succeeds", async () => {
    const ch = await federatedChannel();
    const stale = await generateActorKey();
    const cacheKey = await remoteKeyCacheKey(peer.keyId);
    await valkey.set(
      cacheKey,
      JSON.stringify({ keyId: peer.keyId, owner: peer.actorId, publicKeyPem: stale.publicKeyPem }),
      "EX",
      600,
    );
    const item = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id));
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "accepted", reason: "follow" });
    const cached = JSON.parse((await valkey.get(cacheKey)) ?? "{}") as { publicKeyPem?: string };
    expect(cached.publicKeyPem).toBe((peer.actorDocument().publicKey as { publicKeyPem: string }).publicKeyPem);
  });

  test("Undo{Follow} removes the follower", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    const follow = followOf(peer, ch.urls.id);
    const item = await inboxItem(null, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${follow.id}/undo`,
      type: "Undo",
      actor: peer.actorId,
      object: follow,
    });
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "accepted", reason: "unfollow" });
    expect(await followers(ch.channel.id)).toEqual([]);
  });

  test("an actor Delete removes that actor everywhere", async () => {
    const a = await federatedChannel();
    const b = await federatedChannel();
    await addFollower(a.channel.id);
    await addFollower(b.channel.id);
    await addFollower(b.channel.id, other);
    const item = await inboxItem(null, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${peer.actorId}#delete`,
      type: "Delete",
      actor: peer.actorId,
      object: peer.actorId,
    });
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "accepted", reason: "actor_deleted" });
    expect(await followers(a.channel.id)).toEqual([]);
    expect((await followers(b.channel.id)).map((f) => f.actorId)).toEqual([other.actorId]);
  });

  test("an unsigned actor Delete is refused unless the actor's own server says it is gone", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    const forged = (keyId: string) =>
      inboxItem(
        null,
        {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${peer.actorId}#delete`,
          type: "Delete",
          actor: peer.actorId,
          object: peer.actorId,
        },
        { keyId },
      );
    // A keyId that 404s, on the victim's origin: the victim's actor still answers, so refused.
    let item = await forged(`${peer.origin}/nope#k`);
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "rejected", reason: "key_gone" });
    // A keyId that 404s on another origin: refused without asking the victim's server.
    item = await forged(`${other.origin}/nope#k`);
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "rejected", reason: "key_gone" });
    expect((await followers(ch.channel.id)).map((f) => f.actorId)).toEqual([peer.actorId]);

    // An actor that is really gone (its document 404s too), keyId on its origin: applied.
    const ghost = `${peer.origin}/users/ghost-${crypto.randomUUID()}`;
    await owner.insert(schema.federationFollowers).values({
      id: uuidv7(),
      channelId: ch.channel.id,
      actorId: ghost,
      inbox: `${ghost}/inbox`,
      domain: "127.0.0.1",
    });
    item = await inboxItem(
      null,
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${ghost}#delete`,
        type: "Delete",
        actor: ghost,
        object: ghost,
      },
      { keyId: `${ghost}#main-key` },
    );
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "accepted", reason: "actor_gone" });
    expect((await followers(ch.channel.id)).map((f) => f.actorId)).toEqual([peer.actorId]);
  });

  test("a verified Follow lifts the sweep's drop of the follower's inboxes", async () => {
    const ch = await federatedChannel();
    for (const inbox of [peer.inbox, peer.sharedInbox!])
      await owner
        .insert(schema.federationDeliveries)
        .values({ id: uuidv7(), inbox, status: "dropped", firstFailedAt: new Date(Date.now() - 9 * DAY) })
        .onConflictDoUpdate({ target: schema.federationDeliveries.inbox, set: { status: "dropped" } });
    const item = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id));
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "accepted", reason: "follow" });
    const from = peer.received.length;
    expect(await drain()).toEqual([{ outcome: "delivered", status: 202 }]);
    expect(verifiedOk(deliveredTo(from, "Accept", "Follow")[0])).toBe(true);
    const rows = await owner.select().from(schema.federationDeliveries);
    expect(rows.filter((r) => r.inbox === peer.sharedInbox)).toEqual([]);
    expect(rows.find((r) => r.inbox === peer.inbox)?.status).toBe("ok");
  });

  test("a repeat Follow (new id) gets its own Accept id", async () => {
    const ch = await federatedChannel();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      queued.length = 0;
      const item = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id));
      expect((await runInbox(item.id, ctx(), cfg())).reason).toBe("follow");
      ids.push(((queued[0]!.data as FederationDeliverJob).activity as { id: string }).id);
    }
    expect(await followers(ch.channel.id)).toHaveLength(1);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]!.split("-").slice(0, -1).join("-")).toBe(ids[1]!.split("-").slice(0, -1).join("-"));
  });

  test("the block list is re-checked: a domain blocked after the API accepted the item is refused", async () => {
    const ch = await federatedChannel();
    const item = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id));
    await owner.insert(schema.federationDomainBlocks).values({ domain: "127.0.0.1" });
    try {
      expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "blocked", reason: "domain_blocked" });
      expect(await followers(ch.channel.id)).toEqual([]);
    } finally {
      await owner.delete(schema.federationDomainBlocks).where(eq(schema.federationDomainBlocks.domain, "127.0.0.1"));
    }
  });

  test("anything but Follow, Undo and an actor Delete is dropped without a request", async () => {
    const ch = await federatedChannel();
    const before = peer.received.length;
    const item = await inboxItem(ch.channel.id, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${peer.actorId}/statuses/1/activity`,
      type: "Create",
      actor: peer.actorId,
      object: { type: "Note", content: "hi", inReplyTo: ch.urls.id },
    });
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "ignored", reason: "unhandled_type" });
    expect(peer.received.length).toBe(before);
  });

  test("a request signed for another host is refused", async () => {
    const ch = await federatedChannel();
    const signed = await peer.sign(`https://elsewhere.example${inboxPath(ch.channel.id)}`, followOf(peer, ch.urls.id));
    const [item] = await owner
      .insert(schema.federationInboxItems)
      .values({ id: uuidv7(), channelId: ch.channel.id, headers: signed.headers, body: signed.body })
      .returning();
    expect(await runInbox(item!.id, ctx(), cfg())).toEqual({ outcome: "rejected", reason: "host_mismatch" });
  });

  test("the SSRF guard refuses a private key URL without the harness flag", async () => {
    const ch = await federatedChannel();
    await valkey.del(await remoteKeyCacheKey(peer.keyId));
    const item = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id));
    expect(await runInbox(item.id, ctx(), cfg({ allowInsecure: false }))).toEqual({
      outcome: "rejected",
      reason: "key_rejected",
    });
    expect(await followers(ch.channel.id)).toEqual([]);
  });

  test("a transient key fetch failure defers the item to the next attempt, which accepts it", async () => {
    const ch = await federatedChannel();
    // A peer on a host name, so the resolver decides where its key fetch connects: first to an
    // address nothing listens on (no answer, as when the remote is briefly unreachable), then to it.
    const flaky = await startActivityPubPeer({ host: "localhost", username: "carol" });
    let lookups = 0;
    const resolve = async () => [
      lookups++ === 0 ? { address: "::1", family: 6 as const } : { address: "127.0.0.1", family: 4 as const },
    ];
    try {
      const item = await inboxItem(ch.channel.id, followOf(flaky, ch.urls.id), { from: flaky });
      await expect(runInbox(item.id, ctx(), cfg({ resolve }), { lastAttempt: false })).rejects.toBeInstanceOf(
        InboxRetry,
      );
      const [pending] = await owner
        .select()
        .from(schema.federationInboxItems)
        .where(eq(schema.federationInboxItems.id, item.id));
      expect(pending).toMatchObject({ processedAt: null, outcome: null });
      expect(await followers(ch.channel.id)).toEqual([]);
      expect(queued).toEqual([]);

      expect(await runInbox(item.id, ctx(), cfg({ resolve }), { lastAttempt: false })).toEqual({
        outcome: "accepted",
        reason: "follow",
      });
      expect((await followers(ch.channel.id)).map((f) => f.actorId)).toEqual([flaky.actorId]);
      expect(queued.map((j) => j.name)).toEqual([FEDERATION_JOBS.deliver]);
    } finally {
      await flaky.close();
    }
  });

  test("the last attempt rejects a transient key failure; a final one rejects on any attempt", async () => {
    const ch = await federatedChannel();
    const keys = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
    try {
      const item = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id), {
        keyId: `http://127.0.0.1:${keys.port}/key#main`,
      });
      expect(await runInbox(item.id, ctx(), cfg(), { lastAttempt: true })).toEqual({
        outcome: "rejected",
        reason: "key_failed",
      });
    } finally {
      await keys.stop(true);
    }
    // A 404 is the remote's final word: no retry even with attempts left.
    const gone = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id), { keyId: `${peer.origin}/nope#k` });
    expect(await runInbox(gone.id, ctx(), cfg(), { lastAttempt: false })).toEqual({
      outcome: "rejected",
      reason: "key_gone",
    });
    expect(await followers(ch.channel.id)).toEqual([]);
  });

  test("a Follow of a channel that does not federate is ignored", async () => {
    const ch = await federatedChannel({ enabled: false });
    const item = await inboxItem(ch.channel.id, followOf(peer, ch.urls.id));
    expect(await runInbox(item.id, ctx(), cfg())).toEqual({ outcome: "ignored", reason: "not_federated" });
    expect(await followers(ch.channel.id)).toEqual([]);
  });
});

// ------------------------------------------------------------ fan-out

async function liveBroadcast(channelId: string, over: Partial<typeof schema.broadcasts.$inferInsert> = {}) {
  const b = await makeBroadcast(owner, channelId);
  await owner
    .update(schema.broadcasts)
    .set({ title: "Late night synths", thumbnailKey: `thumbs/${b.id}/latest.jpg`, ...over })
    .where(eq(schema.broadcasts.id, b.id));
  return b;
}

async function goLiveEvent(ch: Awaited<ReturnType<typeof federatedChannel>>, broadcastId: string) {
  return insertEvent(owner, "stream.online", ch.channel.id, {
    ...broadcasterFields({ id: ch.user.id, username: ch.user.username ?? "", name: ch.user.name }),
    id: broadcastId,
    type: "live",
    started_at: new Date().toISOString(),
  });
}

async function publicVod(channelId: string, broadcastId: string) {
  const id = uuidv7();
  const prefix = vodPrefix(id, "public");
  await owner.insert(schema.vods).values({
    id,
    broadcastId,
    channelId,
    title: "Highlights",
    status: "ready",
    visibility: "public",
    storagePrefix: prefix,
    durationSeconds: 754,
    thumbnailKey: `${prefix}thumb.jpg`,
  });
  return id;
}

describe("fan-out", () => {
  test("go-live delivers a signed Create{Note} with the thumbnail, once per shared inbox", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    const b = await liveBroadcast(ch.channel.id);
    const e = await goLiveEvent(ch, b.id);
    const from = peer.received.length;
    expect(await runFanout(e.id, ctx(), cfg())).toEqual({ outcome: "created", deliveries: 1 });
    expect((queued[0]!.data as FederationDeliverJob).inbox).toBe(peer.sharedInbox);
    await drain();
    const [create] = deliveredTo(from, "Create", "Note");
    expect(verifiedOk(create)).toBe(true);
    const note = create?.json?.object as Record<string, unknown>;
    expect(note.attributedTo).toBe(ch.urls.id);
    expect(note.sensitive).toBe(false);
    expect(note.attachment).toEqual([
      {
        type: "Image",
        url: `https://media.air.example/media/thumbs/${b.id}/latest.jpg`,
        mediaType: "image/jpeg",
        name: "Late night synths",
      },
    ]);
    const [obj] = await owner
      .select()
      .from(schema.federationObjects)
      .where(eq(schema.federationObjects.subjectId, b.id));
    expect(note.id).toBe(objectUrl(ORIGIN, obj!.id));

    // At least once, same id: a second run sends the same activity id.
    queued.length = 0;
    await runFanout(e.id, ctx(), cfg());
    expect(((queued[0]!.data as FederationDeliverJob).activity as { id: string }).id).toBe(create?.json?.id);
  });

  test("a mature channel's Note has no thumbnail and is sensitive with a warning", async () => {
    const ch = await federatedChannel({ mature: true });
    await addFollower(ch.channel.id);
    const b = await liveBroadcast(ch.channel.id);
    const from = peer.received.length;
    await runFanout((await goLiveEvent(ch, b.id)).id, ctx(), cfg());
    await drain();
    const note = deliveredTo(from, "Create", "Note")[0]?.json?.object as Record<string, unknown>;
    expect(note.attachment).toEqual([]);
    expect(note.sensitive).toBe(true);
    expect(note.summary).toBe("Mature content (18+)");
    expect(JSON.stringify(note)).not.toContain("latest.jpg");
  });

  test("a mature category marks the Note, the VOD and the clip sensitive, as the API's media gate does", async () => {
    const [cat] = await owner
      .insert(schema.categories)
      .values({ slug: `adult-${crypto.randomUUID()}`, name: "Adult", mature: true })
      .returning();
    // The channel's own category.
    const a = await federatedChannel();
    await owner.update(schema.channels).set({ categoryId: cat!.id }).where(eq(schema.channels.id, a.channel.id));
    await addFollower(a.channel.id);
    let from = peer.received.length;
    await runFanout((await goLiveEvent(a, (await liveBroadcast(a.channel.id)).id)).id, ctx(), cfg());
    await drain();
    const note = deliveredTo(from, "Create", "Note")[0]?.json?.object as Record<string, unknown>;
    expect(note.sensitive).toBe(true);
    expect(note.attachment).toEqual([]);

    // The broadcast's category, for a VOD and a clip of it.
    const b = await federatedChannel();
    await addFollower(b.channel.id);
    const bc = await liveBroadcast(b.channel.id, { endedAt: new Date(), categoryId: cat!.id });
    const vodId = await publicVod(b.channel.id, bc.id);
    from = peer.received.length;
    const vodEvent = await insertEvent(owner, "media.vod.state", b.channel.id, {
      vod_id: vodId,
      channel_id: b.channel.id,
      public: true,
      reason: "ready",
    });
    expect((await runFanout(vodEvent.id, ctx(), cfg())).outcome).toBe("created");
    const clipId = uuidv7();
    await owner.insert(schema.clips).values({
      id: clipId,
      channelId: b.channel.id,
      broadcastId: bc.id,
      creatorId: b.user.id,
      title: "That moment",
      status: "ready",
      startOffset: 12,
      durationSeconds: 30,
      thumbnailKey: `clips/${clipId}/thumb.jpg`,
    });
    const clipEvent = await insertEvent(owner, "media.clip.state", b.channel.id, {
      clip_id: clipId,
      channel_id: b.channel.id,
      public: true,
      reason: "ready",
    });
    expect((await runFanout(clipEvent.id, ctx(), cfg())).outcome).toBe("created");
    await drain();
    const videos = deliveredTo(from, "Create", "Video").map((r) => r.json?.object as Record<string, unknown>);
    expect(videos).toHaveLength(2);
    for (const v of videos) {
      expect(v.sensitive).toBe(true);
      expect(JSON.stringify(v)).not.toContain("thumb.jpg");
    }
  });

  test("a VOD made public delivers a Video; removal sends Delete with a Tombstone", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    const b = await liveBroadcast(ch.channel.id, { endedAt: new Date() });
    const vodId = await publicVod(ch.channel.id, b.id);
    const pub = await insertEvent(owner, "media.vod.state", ch.channel.id, {
      vod_id: vodId,
      channel_id: ch.channel.id,
      public: true,
      reason: "ready",
    });
    let from = peer.received.length;
    expect((await runFanout(pub.id, ctx(), cfg())).outcome).toBe("created");
    await drain();
    const [create] = deliveredTo(from, "Create", "Video");
    expect(verifiedOk(create)).toBe(true);
    const video = create?.json?.object as Record<string, unknown>;
    expect(video.url).toEqual([
      { type: "Link", mediaType: "text/html", href: `${ORIGIN}/${ch.channel.slug}/vods/${vodId}` },
    ]);
    expect(video.duration).toBe("PT754S");
    expect(JSON.stringify(video)).not.toContain(".m3u8");

    await owner.update(schema.vods).set({ visibility: "subscribers" }).where(eq(schema.vods.id, vodId));
    const hidden = await insertEvent(owner, "media.vod.state", ch.channel.id, {
      vod_id: vodId,
      channel_id: ch.channel.id,
      public: false,
      reason: "visibility",
    });
    from = peer.received.length;
    expect((await runFanout(hidden.id, ctx(), cfg())).outcome).toBe("deleted");
    await drain();
    const [del] = deliveredTo(from, "Delete", "Tombstone");
    expect(verifiedOk(del)).toBe(true);
    expect(del?.json?.object).toMatchObject({ id: video.id, formerType: "Video" });
    // Deleted once; a repeat or a later "public" does not re-publish the tombstoned id.
    expect((await runFanout(hidden.id, ctx(), cfg())).outcome).toBe("skipped");
    await owner.update(schema.vods).set({ visibility: "public" }).where(eq(schema.vods.id, vodId));
    expect((await runFanout(pub.id, ctx(), cfg())).outcome).toBe("skipped");
  });

  test("a subscriber-only VOD never federates", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    const b = await liveBroadcast(ch.channel.id, { endedAt: new Date() });
    const vodId = await publicVod(ch.channel.id, b.id);
    await owner.update(schema.vods).set({ visibility: "subscribers" }).where(eq(schema.vods.id, vodId));
    const e = await insertEvent(owner, "media.vod.state", ch.channel.id, {
      vod_id: vodId,
      channel_id: ch.channel.id,
      public: true,
      reason: "visibility",
    });
    expect(await runFanout(e.id, ctx(), cfg())).toEqual({ outcome: "skipped", deliveries: 0 });
    expect(queued).toEqual([]);
  });

  test("a T1 restriction deletes the broadcast's Note", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    const b = await liveBroadcast(ch.channel.id);
    await runFanout((await goLiveEvent(ch, b.id)).id, ctx(), cfg());
    queued.length = 0;
    const e = await insertEvent(owner, "moderation.restriction", ch.channel.id, {
      broadcast_id: b.id,
      channel_id: ch.channel.id,
      case_id: uuidv7(),
      restricted: true,
    });
    const from = peer.received.length;
    expect((await runFanout(e.id, ctx(), cfg())).outcome).toBe("deleted");
    await drain();
    const [del] = deliveredTo(from, "Delete", "Tombstone");
    expect(verifiedOk(del)).toBe(true);
    expect((del!.json!.object as { formerType: string }).formerType).toBe("Note");
  });

  test("suspension sends Delete of the actor and drops the followers", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    await owner
      .update(schema.channels)
      .set({ suspendedAt: new Date(), suspendedReason: "test" })
      .where(eq(schema.channels.id, ch.channel.id));
    const e = await insertEvent(owner, "channel.suspension", ch.channel.id, {
      channel_id: ch.channel.id,
      suspended: true,
    });
    const from = peer.received.length;
    expect(await runFanout(e.id, ctx(), cfg())).toEqual({ outcome: "actor_deleted", deliveries: 1 });
    expect(await followers(ch.channel.id)).toEqual([]);
    await drain();
    const [del] = peer.since(from, (r) => r.type === "Delete" && r.json?.object === ch.urls.id);
    expect(verifiedOk(del)).toBe(true);
  });

  test("nothing is created when the instance flag or the channel setting is off", async () => {
    const on = await federatedChannel();
    await addFollower(on.channel.id);
    const b = await liveBroadcast(on.channel.id);
    const e = await goLiveEvent(on, b.id);
    expect(await runFanout(e.id, ctx(), cfg({ enabled: false }))).toEqual({ outcome: "skipped", deliveries: 0 });

    const off = await federatedChannel({ enabled: false });
    await addFollower(off.channel.id);
    const b2 = await liveBroadcast(off.channel.id);
    expect((await runFanout((await goLiveEvent(off, b2.id)).id, ctx(), cfg())).outcome).toBe("skipped");
    expect(queued).toEqual([]);
  });
});

// ------------------------------------------------------------ delivery, sweep, rotation

describe("delivery", () => {
  const job = (channelId: string, attempt = 1): FederationDeliverJob => ({
    channelId,
    inbox: peer.inbox,
    objectId: null,
    activity: {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${ORIGIN}/test/${crypto.randomUUID()}`,
      type: "Note",
    },
    attempt,
  });
  const health = async (inbox: string) =>
    (await owner.select().from(schema.federationDeliveries).where(eq(schema.federationDeliveries.inbox, inbox)))[0];

  test("a failure retries on the webhook backoff; a success clears the failing streak", async () => {
    const ch = await federatedChannel();
    await owner.delete(schema.federationDeliveries).where(eq(schema.federationDeliveries.inbox, peer.inbox));
    peer.failNext(1, 503);
    expect(await runDeliver(job(ch.channel.id), ctx(), cfg())).toEqual({ outcome: "retrying", status: 503 });
    expect(queued).toHaveLength(1);
    const next = queued[0]!;
    expect((next.data as FederationDeliverJob).attempt).toBe(2);
    expect(next.opts?.delayMs).toBeGreaterThanOrEqual(BACKOFF[0] * 0.9);
    expect(next.opts?.delayMs).toBeLessThanOrEqual(BACKOFF[0] * 1.1);
    expect(next.opts?.jobId).toMatch(/^federation-deliver-[0-9a-f]+-2$/);
    const failing = await health(peer.inbox);
    expect(failing?.status).toBe("failing");
    expect(failing?.firstFailedAt).not.toBeNull();

    expect(await drain()).toEqual([{ outcome: "delivered", status: 202 }]);
    const ok = await health(peer.inbox);
    expect(ok?.status).toBe("ok");
    expect(ok?.firstFailedAt).toBeNull();
  });

  test("the last attempt and a final 4xx do not retry", async () => {
    const ch = await federatedChannel();
    peer.failNext(1, 500);
    expect((await runDeliver(job(ch.channel.id, 5), ctx(), cfg())).outcome).toBe("failed");
    peer.failNext(1, 403);
    expect((await runDeliver(job(ch.channel.id, 1), ctx(), cfg())).outcome).toBe("failed");
    expect(queued).toEqual([]);
  });

  test("nothing is sent with the instance flag off, or to a blocked domain", async () => {
    const ch = await federatedChannel();
    const before = peer.received.length;
    expect(await runDeliver(job(ch.channel.id), ctx(), cfg({ enabled: false }))).toEqual({ outcome: "disabled" });
    await owner.insert(schema.federationDomainBlocks).values({ domain: "127.0.0.1" });
    try {
      expect(await runDeliver(job(ch.channel.id), ctx(), cfg())).toEqual({ outcome: "blocked" });
    } finally {
      await owner.delete(schema.federationDomainBlocks).where(eq(schema.federationDomainBlocks.domain, "127.0.0.1"));
    }
    expect(peer.received.length).toBe(before);
  });

  test("the SSRF guard refuses a private inbox without the harness flag", async () => {
    const ch = await federatedChannel();
    const before = peer.received.length;
    expect((await runDeliver(job(ch.channel.id), ctx(), cfg({ allowInsecure: false }))).outcome).toBe("failed");
    expect(peer.received.length).toBe(before);
  });
});

describe("sweep", () => {
  test("an inbox failing for 7 days loses its followers and is dropped; old inbox items go", async () => {
    const ch = await federatedChannel();
    const deadInbox = `http://127.0.0.1:9/inbox/${crypto.randomUUID()}`;
    await owner.insert(schema.federationFollowers).values({
      id: uuidv7(),
      channelId: ch.channel.id,
      actorId: `http://127.0.0.1:9/users/${crypto.randomUUID()}`,
      inbox: deadInbox,
      domain: "127.0.0.1",
    });
    await addFollower(ch.channel.id);
    const now = new Date();
    await owner.insert(schema.federationDeliveries).values({
      id: uuidv7(),
      inbox: deadInbox,
      status: "failing",
      firstFailedAt: new Date(now.getTime() - 6 * DAY),
      lastAttemptAt: now,
    });
    const old = await owner
      .insert(schema.federationInboxItems)
      .values({ id: uuidv7(), headers: {}, body: "{}", receivedAt: new Date(now.getTime() - 8 * DAY) })
      .returning();

    // Six days failing: kept.
    clock = () => now;
    expect((await runSweep(ctx(), cfg())).droppedFollowers).toBe(0);
    // Two days later (an injected clock), with a failed attempt a day and a half on: the failures
    // span seven and a half days, dropped.
    await owner
      .update(schema.federationDeliveries)
      .set({ lastAttemptAt: new Date(now.getTime() + 1.5 * DAY) })
      .where(eq(schema.federationDeliveries.inbox, deadInbox));
    clock = () => new Date(now.getTime() + 2 * DAY);
    const r = await runSweep(ctx(), cfg());
    expect(r.droppedInboxes).toBeGreaterThanOrEqual(1);
    expect((await followers(ch.channel.id)).map((f) => f.inbox)).toEqual([peer.inbox]);
    const [h] = await owner
      .select()
      .from(schema.federationDeliveries)
      .where(eq(schema.federationDeliveries.inbox, deadInbox));
    expect(h?.status).toBe("dropped");
    expect(
      await owner.select().from(schema.federationInboxItems).where(eq(schema.federationInboxItems.id, old[0]!.id)),
    ).toEqual([]);
    // A dropped inbox is not delivered to.
    expect(
      (
        await runDeliver(
          { channelId: ch.channel.id, inbox: deadInbox, objectId: null, activity: { id: "x" }, attempt: 1 },
          ctx(),
          cfg(),
        )
      ).outcome,
    ).toBe("blocked");
  });

  test("one failed burst followed by a quiet week does not drop the inbox", async () => {
    const ch = await federatedChannel();
    const inbox = `http://127.0.0.1:9/inbox/${crypto.randomUUID()}`;
    await owner.insert(schema.federationFollowers).values({
      id: uuidv7(),
      channelId: ch.channel.id,
      actorId: `http://127.0.0.1:9/users/${crypto.randomUUID()}`,
      inbox,
      domain: "127.0.0.1",
    });
    const burst = new Date(Date.now() - 8 * DAY);
    // Retries stopped about 2.6 h after the first failure, eight days ago.
    await owner.insert(schema.federationDeliveries).values({
      id: uuidv7(),
      inbox,
      status: "failing",
      firstFailedAt: burst,
      lastAttemptAt: new Date(burst.getTime() + 3 * 3_600_000),
    });
    await runSweep(ctx(), cfg());
    expect((await followers(ch.channel.id)).map((f) => f.inbox)).toEqual([inbox]);
    const [h] = await owner
      .select()
      .from(schema.federationDeliveries)
      .where(eq(schema.federationDeliveries.inbox, inbox));
    expect(h?.status).toBe("failing");
  });

  test("a channel turned off with followers left sends Delete of the actor", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    await owner
      .update(schema.channels)
      .set({ federationSettings: { enabled: false } })
      .where(eq(schema.channels.id, ch.channel.id));
    const from = peer.received.length;
    expect((await runSweep(ctx(), cfg())).actorDeletes).toBeGreaterThanOrEqual(1);
    expect(await followers(ch.channel.id)).toEqual([]);
    await drain();
    expect(verifiedOk(peer.since(from, (r) => r.type === "Delete" && r.json?.object === ch.urls.id)[0])).toBe(true);
  });
});

describe("rotation", () => {
  test("a key older than a year rotates: history and audit rows, and a signed Update with the new key", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    await owner
      .update(schema.federationActors)
      .set({ keyCreatedAt: new Date(Date.now() - 366 * DAY) })
      .where(eq(schema.federationActors.channelId, ch.channel.id));
    const r = await runRotate({}, ctx(), cfg());
    expect(r.rotated).toBeGreaterThanOrEqual(1);
    const [actor] = await owner
      .select()
      .from(schema.federationActors)
      .where(eq(schema.federationActors.channelId, ch.channel.id));
    expect(actor?.publicKeyPem).not.toBe(ch.pair.publicKeyPem);
    const history = await owner
      .select()
      .from(schema.federationActorKeys)
      .where(eq(schema.federationActorKeys.channelId, ch.channel.id));
    expect(history.map((h) => h.publicKeyPem)).toEqual([ch.pair.publicKeyPem]);
    const audit = await owner
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, ch.channel.id), eq(schema.auditLog.action, "federation.key.rotate")));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toEqual({ reason: "scheduled" });

    const from = peer.received.length;
    await drain();
    const [update] = peer.since(from, (r2) => r2.type === "Update" && r2.objectType === "Service");
    expect(verifiedOk(update)).toBe(true);
    expect((update!.json!.object as { publicKey: { publicKeyPem: string } }).publicKey.publicKeyPem).toBe(
      actor?.publicKeyPem,
    );
  });

  test("an admin rotation (channelId) sends Update; nothing with the flag off", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    expect(await runRotate({ channelId: ch.channel.id }, ctx(), cfg({ enabled: false }))).toEqual({
      rotated: 0,
      updates: 0,
      deliveries: 0,
    });
    expect(await runRotate({ channelId: ch.channel.id }, ctx(), cfg())).toEqual({
      rotated: 0,
      updates: 1,
      deliveries: 1,
    });
  });
});

describe("account deletion", () => {
  test("the actor's Delete is captured in the transaction, queued after commit and signed with the stash", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    const { counts, retired } = await t.app.db.transaction(async (tx) => {
      const r = await captureRetiredActor(tx, ch.channel.id, cfg());
      return { counts: await deleteFederationData(tx, ch.channel.id), retired: r };
    });
    expect(counts).toEqual({ federation_followers: 1, federation_actors: 1 });
    // Nothing leaves inside the transaction.
    expect(queued).toEqual([]);
    expect(retired?.inboxes).toEqual([peer.sharedInbox]);
    expect(
      await owner.select().from(schema.federationActors).where(eq(schema.federationActors.channelId, ch.channel.id)),
    ).toEqual([]);
    expect(await sendRetiredActorDelete(ctx(), cfg(), retired!)).toBe(1);
    const from = peer.received.length;
    expect(await drain()).toEqual([{ outcome: "delivered", status: 202 }]);
    expect(verifiedOk(peer.since(from, (r) => r.type === "Delete" && r.json?.object === ch.urls.id)[0])).toBe(true);
  });

  test("a rolled-back deletion sends nothing", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    let retired: Awaited<ReturnType<typeof captureRetiredActor>> = null;
    await expect(
      t.app.db.transaction(async (tx) => {
        retired = await captureRetiredActor(tx, ch.channel.id, cfg());
        await deleteFederationData(tx, ch.channel.id);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(retired).not.toBeNull();
    expect(queued).toEqual([]);
    expect(await followers(ch.channel.id)).toHaveLength(1);
  });

  test("with the flag off nothing is captured; only the rows go", async () => {
    const ch = await federatedChannel();
    await addFollower(ch.channel.id);
    const { counts, retired } = await t.app.db.transaction(async (tx) => ({
      retired: await captureRetiredActor(tx, ch.channel.id, cfg({ enabled: false })),
      counts: await deleteFederationData(tx, ch.channel.id),
    }));
    expect(retired).toBeNull();
    expect(counts).toEqual({ federation_followers: 1, federation_actors: 1 });
    expect(queued).toEqual([]);
  });
});
