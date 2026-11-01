// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `INTERNAL_ROUTES.uploadCommit` (decision (p)): the worker's imports go through the same
 * `commitUpload` a user upload does. A T0 fixture image (on the fixture CSAM list) is refused with
 * the same opaque code and enqueues the same `moderation.t0` job as through `channels.commitUpload`;
 * a benign image is published. Secret-gated; the key must be the channel's and of the purpose.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, MODERATION_JOBS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { startModeration } from "../src/moderation/index.ts";
import { recordingQueue } from "../src/moderation/queue.ts";
import { incomingKey } from "../src/moderation/upload-keys.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

const FIXTURES = new URL("../../../packages/moderation/fixtures/", import.meta.url);
const queue = recordingQueue();
let api: TestApi;
let alice: Awaited<ReturnType<typeof signUpAndSignIn>>;
let channelId: string;

beforeAll(async () => {
  api = await startApi({
    env: {
      MODERATION_HASHLIST_CSAM: new URL("csam.pdq", FIXTURES).pathname,
      MODERATION_TEST_HOOKS: "true",
      MODERATION_CLASSIFIER: "scripted",
    },
  });
  // Before anything touches the runtime: later overrides are ignored.
  await startModeration(api.deps, { queue });
  alice = await signUpAndSignIn(api);
  const [c] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.slug, alice.username));
  if (!c) throw new Error("no channel");
  channelId = c.id;
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const fixture = async (name: string) => new Uint8Array(await Bun.file(new URL(name, FIXTURES)).arrayBuffer());

async function stage(purpose: "emote" | "panel", name: string, channel = channelId): Promise<string> {
  const key = incomingKey(channel, purpose, uuidv7(), "image/png");
  await api.deps.storage.put(api.deps.env.S3_BUCKET_MEDIA, key, await fixture(name), { contentType: "image/png" });
  return key;
}

const commit = (body: unknown, secret: string | null = api.internalSecret, method: "POST" | "PUT" = "POST") => {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...(secret ? { [INTERNAL_SECRET_HEADER]: secret } : {}) },
    body: JSON.stringify(body),
  };
  return fetch(`${api.url}${INTERNAL_ROUTES.uploadCommit}`, init);
};

/** The T0 job minus what differs per upload (its subject id, capture time and sealed evidence). */
const shape = (data: unknown) => {
  const { subjectId: _s, capturedAt: _c, evidence, ...rest } = data as Record<string, unknown>;
  return { ...rest, evidence: (evidence as unknown[]).length };
};

describe("internal upload commit", () => {
  test("a T0 fixture is refused and enqueues the T0 job exactly as a user upload does", async () => {
    queue.jobs.length = 0;
    const internalKey = await stage("emote", "t0-pattern.png");
    const r = await commit({ channelId, userId: alice.userId, key: internalKey, purpose: "emote" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: false, code: "upload_rejected" });
    // The incoming object is gone, nothing was published.
    expect(await api.deps.storage.get(api.deps.env.S3_BUCKET_MEDIA, internalKey)).toBeNull();
    expect(await api.deps.storage.get(api.deps.env.S3_BUCKET_MEDIA, internalKey.replace(/^incoming\//, ""))).toBeNull();

    const userKey = await stage("emote", "t0-pattern.png");
    const user = await alice.client.call<{ data?: { reason?: string } }>(
      "POST",
      `/api/channels/${alice.username}/uploads/commit`,
      { key: userKey },
    );
    expect(user.status).toBe(422);
    expect(user.body.data?.reason).toBe("upload_rejected");

    expect(queue.jobs.map((j) => j.name)).toEqual([MODERATION_JOBS.t0, MODERATION_JOBS.t0]);
    const [viaInternal, viaUser] = queue.jobs;
    expect(viaInternal?.data).toMatchObject({
      subjectType: "upload",
      channelId,
      userId: alice.userId,
      uploadPurpose: "emote",
      listCategory: "csam",
    });
    expect(shape(viaInternal?.data)).toEqual(shape(viaUser?.data));
  });

  test("a benign image is published under its public key", async () => {
    const key = await stage("panel", "benign-gradient.png");
    const r = await commit({ channelId, userId: alice.userId, key, purpose: "panel" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; key: string; url: string };
    expect(body).toMatchObject({ ok: true, key: key.replace(/^incoming\//, "") });
    expect(await api.deps.storage.get(api.deps.env.S3_BUCKET_MEDIA, body.key)).not.toBeNull();
  });

  test("the secret, the method, the body and the key are checked", async () => {
    const key = await stage("emote", "benign-gradient.png");
    const body = { channelId, userId: alice.userId, key, purpose: "emote" };
    expect((await commit(body, null)).status).toBe(401);
    expect((await commit(body, "wrong")).status).toBe(401);
    expect((await commit(body, api.internalSecret, "PUT")).status).toBe(405);
    expect((await commit({ ...body, purpose: "avatar" })).status).toBe(400);
    // The key's purpose must be the one given, and the key must be the channel's.
    expect((await commit({ ...body, purpose: "panel" })).status).toBe(400);
    expect((await commit({ ...body, channelId: uuidv7() })).status).toBe(400);
    // A key of the right shape whose object is not there.
    const missing = incomingKey(channelId, "emote", uuidv7(), "image/png");
    expect((await commit({ ...body, key: missing })).status).toBe(404);
  });
});
