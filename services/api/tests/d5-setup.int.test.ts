// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-dashboard: `stream.setupState` derives each checklist step from the rows other features write
 * (one step per test, on a fresh channel), and `stream.setupMark` records the owner-marked step
 * idempotently. The HTTP tests cover the owner gate and the route shapes.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { StreamSetupState } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { markSetupStep, readSetupState, setupStepMarked } from "../src/studio/setup.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let owner: User;
let other: User;

beforeAll(async () => {
  api = await startApi();
  [owner, other] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const admin = () => api.db.db;
const app = () => api.db.app.db;

let n = 0;
async function freshChannel(intent: "import" | "stream" | null = null) {
  n += 1;
  const name = `setup${n}${crypto.randomUUID().slice(0, 6)}`;
  const [u] = await admin()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name, signupIntent: intent })
    .returning({ id: schema.users.id });
  if (!u) throw new Error("no user");
  const [c] = await admin()
    .insert(schema.channels)
    .values({ ownerId: u.id, slug: name, displayName: name })
    .returning({ id: schema.channels.id });
  if (!c) throw new Error("no channel");
  return { userId: u.id, channelId: c.id };
}

const doneOf = (s: StreamSetupState) => Object.fromEntries(s.steps.map((x) => [x.step, x.done]));
const state = (channelId: string, available = true) => readSetupState(app(), channelId, available);

async function broadcast(channelId: string, kind: "live" | "rehearsal", ended = true) {
  await admin()
    .insert(schema.broadcasts)
    .values({
      channelId,
      kind,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      startedAt: new Date(Date.now() - 600_000),
      endedAt: ended ? new Date() : null,
    });
}

describe("readSetupState, one step at a time", () => {
  test("a new channel has nothing done", async () => {
    const { channelId } = await freshChannel();
    const s = await state(channelId);
    expect(s.complete).toBe(false);
    expect(s.signupIntent).toBeNull();
    expect(doneOf(s)).toEqual({
      channel_profile: false,
      stream_info: false,
      stream_key: false,
      encoder_connected: false,
      rehearsal: false,
      first_live: false,
      import_twitch: null,
      get_paid: null,
      bring_your_audience: false,
    });
  });

  test("channel_profile: a description, a theme avatar, or the owner's picture", async () => {
    const a = await freshChannel();
    await admin()
      .update(schema.channels)
      .set({ description: "Watercolour harbours" })
      .where(eq(schema.channels.id, a.channelId));
    expect(doneOf(await state(a.channelId)).channel_profile).toBe(true);
    const b = await freshChannel();
    await admin()
      .update(schema.channels)
      .set({ theme: { avatarKey: `channels/${b.channelId}/avatar/x.webp` } })
      .where(eq(schema.channels.id, b.channelId));
    expect(doneOf(await state(b.channelId)).channel_profile).toBe(true);
    const c = await freshChannel();
    await admin()
      .update(schema.users)
      .set({ image: "https://example.test/a.png" })
      .where(eq(schema.users.id, c.userId));
    expect(doneOf(await state(c.channelId)).channel_profile).toBe(true);
  });

  test("stream_info needs both the title and the category", async () => {
    const { channelId } = await freshChannel();
    await admin().update(schema.channels).set({ title: "First stream" }).where(eq(schema.channels.id, channelId));
    expect(doneOf(await state(channelId)).stream_info).toBe(false);
    const [cat] = await admin()
      .insert(schema.categories)
      .values({ slug: `cat-${uuidv7()}`, name: "Art" })
      .returning({ id: schema.categories.id });
    await admin().update(schema.channels).set({ categoryId: cat?.id }).where(eq(schema.channels.id, channelId));
    expect(doneOf(await state(channelId)).stream_info).toBe(true);
  });

  test("stream_key: an unrevoked key only", async () => {
    const { channelId } = await freshChannel();
    const [k] = await admin()
      .insert(schema.streamKeys)
      .values({ channelId, keyHash: uuidv7(), prefix: "abcd", revokedAt: new Date(), revokedReason: "rotated" })
      .returning({ id: schema.streamKeys.id });
    expect(k).toBeTruthy();
    expect(doneOf(await state(channelId)).stream_key).toBe(false);
    await admin().insert(schema.streamKeys).values({ channelId, keyHash: uuidv7(), prefix: "efgh" });
    expect(doneOf(await state(channelId)).stream_key).toBe(true);
  });

  test("encoder_connected: an open broadcast (connected now) ticks it, and stays ticked after it ends", async () => {
    const { channelId } = await freshChannel();
    await broadcast(channelId, "live", false);
    const s = doneOf(await state(channelId));
    expect(s.encoder_connected).toBe(true);
    expect(s.first_live).toBe(true);
    expect(s.rehearsal).toBe(false);
  });

  test("rehearsal: a rehearsal broadcast connects the encoder but is not the first live", async () => {
    const { channelId } = await freshChannel();
    await broadcast(channelId, "rehearsal");
    const s = doneOf(await state(channelId));
    expect(s).toMatchObject({ encoder_connected: true, rehearsal: true, first_live: false });
  });

  test("import_twitch: null without the import intent; then a finished Twitch import", async () => {
    const plain = await freshChannel("stream");
    expect(doneOf(await state(plain.channelId)).import_twitch).toBeNull();
    const imp = await freshChannel("import");
    expect((await state(imp.channelId)).signupIntent).toBe("import");
    expect(doneOf(await state(imp.channelId)).import_twitch).toBe(false);
    expect(doneOf(await state(imp.channelId, false)).import_twitch).toBeNull();
    await admin()
      .insert(schema.portabilityImports)
      .values({ userId: imp.userId, channelId: imp.channelId, source: "twitch", status: "failed" });
    expect(doneOf(await state(imp.channelId)).import_twitch).toBe(false);
    await admin().insert(schema.portabilityImports).values({
      userId: imp.userId,
      channelId: imp.channelId,
      source: "twitch",
      status: "done",
      finishedAt: new Date(),
    });
    expect(doneOf(await state(imp.channelId)).import_twitch).toBe(true);
  });

  test("bring_your_audience: marked once, a repeat is a no-op", async () => {
    const { channelId } = await freshChannel();
    await markSetupStep(app(), channelId, "bring_your_audience");
    const [first] = await admin()
      .select({ at: schema.channelSetupSteps.createdAt })
      .from(schema.channelSetupSteps)
      .where(eq(schema.channelSetupSteps.channelId, channelId));
    await markSetupStep(app(), channelId, "bring_your_audience");
    const rows = await admin()
      .select({ at: schema.channelSetupSteps.createdAt })
      .from(schema.channelSetupSteps)
      .where(eq(schema.channelSetupSteps.channelId, channelId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.at.getTime()).toBe(first?.at.getTime());
    expect(await setupStepMarked(app(), channelId, "bring_your_audience")).toBe(true);
    expect(doneOf(await state(channelId)).bring_your_audience).toBe(true);
  });

  test("complete: every required step done, the rehearsal skipped", async () => {
    const { channelId } = await freshChannel();
    const [cat] = await admin()
      .insert(schema.categories)
      .values({ slug: `cat-${uuidv7()}`, name: "Music" })
      .returning({ id: schema.categories.id });
    await admin()
      .update(schema.channels)
      .set({ description: "Hi", title: "Live", categoryId: cat?.id })
      .where(eq(schema.channels.id, channelId));
    await admin().insert(schema.streamKeys).values({ channelId, keyHash: uuidv7(), prefix: "wxyz" });
    await broadcast(channelId, "live");
    expect((await state(channelId)).complete).toBe(false);
    await markSetupStep(app(), channelId, "bring_your_audience");
    const s = await state(channelId);
    expect(s.complete).toBe(true);
    expect(doneOf(s).rehearsal).toBe(false);
  });
});

describe("the routes", () => {
  test("the owner reads the checklist and marks the audience step (twice is fine)", async () => {
    const path = `/api/channels/${owner.username}/setup`;
    const before = await owner.client.call<StreamSetupState>("GET", path);
    expect(before.status).toBe(200);
    expect(before.body.steps.find((s) => s.step === "bring_your_audience")?.done).toBe(false);
    for (let i = 0; i < 2; i++) {
      const r = await owner.client.call<{ ok: boolean }>("PUT", `${path}/bring_your_audience`, {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ ok: true });
    }
    const after = await owner.client.call<StreamSetupState>("GET", path);
    expect(after.body.steps.find((s) => s.step === "bring_your_audience")?.done).toBe(true);
    // signUpAndSignIn sends no intent.
    expect(after.body.signupIntent).toBeNull();
  });

  test("a derived step cannot be marked", async () => {
    const r = await owner.client.call("PUT", `/api/channels/${owner.username}/setup/first_live`, {});
    expect(r.status).toBe(400);
  });

  test("someone else's channel and signed-out callers are refused", async () => {
    const path = `/api/channels/${owner.username}/setup`;
    expect((await client(api).call("GET", path)).status).toBe(401);
    expect([403, 404]).toContain((await other.client.call("GET", path)).status);
    expect([403, 404]).toContain((await other.client.call("PUT", `${path}/bring_your_audience`, {})).status);
  });
});
