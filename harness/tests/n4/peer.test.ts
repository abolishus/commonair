// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The in-harness ActivityPub peer and the `federation` scenario's pure helpers: two peers on
 * 127.0.0.1 send each other signed activities; the receiving peer verifies them (draft-cavage via
 * packages/federation), records a bad signature as such, serves WebFinger and its actor, and
 * answers with the injected failures.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { type ActivityPubPeer, startActivityPubPeer } from "../../src/mocks/activitypub/peer.ts";
import {
  acctOf,
  anyCreateFrom,
  arrivedSince,
  isAcceptOf,
  isActorDelete,
  isCreate,
  rewriteToApi,
  webfingerEndpoint,
} from "../../src/n4/match.ts";
import { FEDERATION_STEP_RUNNERS } from "../../src/n4/index.ts";
import { FEDERATION_STEP_NUMBERS } from "../../src/w3/steps.ts";

let alice: ActivityPubPeer;
let bob: ActivityPubPeer;

beforeAll(async () => {
  alice = await startActivityPubPeer({ host: "127.0.0.1" });
  bob = await startActivityPubPeer({ host: "127.0.0.1", username: "bob", sharedInbox: false });
}, 60_000);

afterAll(async () => {
  await alice?.close();
  await bob?.close();
});

describe("activitypub peer", () => {
  test("serves a Mastodon-shaped Person with its key, and WebFinger", async () => {
    const doc = (await (
      await fetch(alice.actorId, { headers: { accept: "application/activity+json" } })
    ).json()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      id: alice.actorId,
      type: "Person",
      preferredUsername: "alice",
      inbox: alice.inbox,
      endpoints: { sharedInbox: alice.sharedInbox },
      publicKey: { id: alice.keyId, owner: alice.actorId },
    });
    const wf = await alice.webfinger(`${alice.origin}/.well-known/webfinger`, "@alice@127.0.0.1");
    expect(wf.actorId).toBe(alice.actorId);
    expect(wf.subject).toBe("acct:alice@127.0.0.1");
    expect(wf.actor.id).toBe(alice.actorId);
    expect(bob.sharedInbox).toBeNull();
  });

  test("a signed Follow is recorded and verifies; a tampered one does not", async () => {
    const from = bob.received.length;
    const { activity, response } = await alice.follow(bob.actorId, bob.inbox);
    expect(response.status).toBe(202);
    const got = await bob.waitFor((r) => r.json?.id === activity.id, 5_000);
    expect(got.type).toBe("Follow");
    expect(got.verified).toMatchObject({ ok: true, actorId: alice.actorId, keyId: alice.keyId });

    const bad = await alice.badSignatureFollow(bob.actorId, bob.inbox);
    expect(bad.status).toBe(202);
    const [, tampered] = bob.since(from);
    expect(tampered?.verified).toEqual({ ok: false, error: "digest_mismatch" });
  });

  test("Undo and an actor Delete arrive signed", async () => {
    const from = bob.received.length;
    const { activity } = await alice.follow(bob.actorId, bob.inbox);
    await alice.undoFollow(activity, bob.inbox);
    await alice.deleteSelf(bob.inbox);
    const [, undo, del] = bob.since(from);
    expect(undo?.type).toBe("Undo");
    expect(undo?.objectType).toBe("Follow");
    expect(undo?.verified.ok).toBe(true);
    expect(isActorDelete(del!, alice.actorId)).toBe(true);
  });

  test("a stale signature date is recorded as skewed", async () => {
    const from = bob.received.length;
    await alice.post(
      bob.inbox,
      { id: `${alice.origin}/x`, type: "Note", actor: alice.actorId },
      {
        date: new Date(Date.now() - 13 * 3_600_000),
      },
    );
    expect(bob.since(from)[0]?.verified).toEqual({ ok: false, error: "date_skew" });
  });

  test("injected failures answer the next posts, then 202 again", async () => {
    bob.failNext(2, 503);
    const s = [];
    for (let i = 0; i < 3; i++)
      s.push((await alice.post(bob.inbox, { id: `${alice.origin}/f${i}`, type: "Note", actor: alice.actorId })).status);
    expect(s).toEqual([503, 503, 202]);
  });

  test("waitFor rejects after its timeout", async () => {
    await expect(bob.waitFor(() => false, 50)).rejects.toThrow(/no matching activity/);
  });
});

describe("federation scenario helpers", () => {
  test("instance URLs are rewritten to the API base; others pass through", () => {
    const o = "http://localhost:3000";
    expect(rewriteToApi(`${o}/ap/channels/x#main-key`, o, "http://localhost:3001/")).toBe(
      "http://localhost:3001/ap/channels/x#main-key",
    );
    expect(rewriteToApi(`${o}/ap/inbox`, o, "http://localhost:3001")).toBe("http://localhost:3001/ap/inbox");
    expect(rewriteToApi("http://localhost:30000/x", o, "http://localhost:3001")).toBe("http://localhost:30000/x");
    expect(rewriteToApi(`${o}/x`, null, "http://localhost:3001")).toBe(`${o}/x`);
    expect(webfingerEndpoint("http://localhost:3001/")).toBe("http://localhost:3001/api/.well-known/webfinger");
    expect(acctOf("@slug@air.example")).toBe("slug@air.example");
  });

  test("activity matchers need a verified signature from the actor", () => {
    const actor = "https://air.example/ap/channels/c";
    const base = {
      path: "/inbox",
      headers: {},
      body: "",
      receivedAt: 0,
      verified: { ok: true as const, keyId: `${actor}#main-key`, actorId: actor, headers: [] },
    };
    const create = {
      ...base,
      type: "Create",
      objectType: "Note",
      json: { type: "Create", actor, object: { type: "Note", attributedTo: actor } },
    };
    expect(isCreate(create, actor, "Note")).toBe(true);
    expect(isCreate(create, actor, "Video")).toBe(false);
    expect(isCreate({ ...create, verified: { ok: false, error: "bad_signature" } }, actor, "Note")).toBe(false);
    expect(anyCreateFrom({ ...create, verified: { ok: false, error: "bad_signature" } }, actor)).toBe(true);
    const accept = {
      ...base,
      type: "Accept",
      objectType: "Follow",
      json: { type: "Accept", actor, object: { id: "f1" } },
    };
    expect(isAcceptOf(accept, actor, "f1")).toBe(true);
    expect(isAcceptOf(accept, actor, "f2")).toBe(false);
  });

  test("arrivedSince matches what lands after the mark, even before the trigger returns", () => {
    const received: string[] = ["note", "video-old"];
    const fresh = arrivedSince(received);
    const isVideo = fresh((r: string) => r.startsWith("video"));
    expect(received.find(isVideo)).toBeUndefined();
    // The delivery lands while the trigger is still running (step 5's goOffline).
    received.push("video-new");
    expect(received.find(isVideo)).toBe("video-new");
    expect(received.find(fresh((r: string) => r === "note"))).toBeUndefined();
    expect(received.find(arrivedSince(received, 0)((r: string) => r === "note"))).toBe("note");
    expect(received.find(arrivedSince(received)(() => true))).toBeUndefined();
  });

  test("every step has a runner", () => {
    for (const n of FEDERATION_STEP_NUMBERS) expect(typeof FEDERATION_STEP_RUNNERS[n]).toBe("function");
  });
});
