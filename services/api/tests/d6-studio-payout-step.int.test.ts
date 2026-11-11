// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d6-studio: `stream.setupState` derives "Get paid" (overhaul wave 4, J2-h) from the owner's payout
 * account (manual or Stripe, `payouts_enabled`) or the owner's mark, only after the first live
 * stream and only on an instance with payouts; it never blocks `complete`. The HTTP test marks it.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { StreamSetupState } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { markSetupStep, readSetupState } from "../src/studio/setup.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
let owner: Awaited<ReturnType<typeof signUpAndSignIn>>;

beforeAll(async () => {
  api = await startApi();
  owner = await signUpAndSignIn(api);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const admin = () => api.db.db;
const app = () => api.db.app.db;

let n = 0;
async function freshChannel(opts: { live?: boolean } = {}) {
  n += 1;
  const name = `paid${n}${crypto.randomUUID().slice(0, 6)}`;
  const [u] = await admin()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: schema.users.id });
  if (!u) throw new Error("no user");
  const [c] = await admin()
    .insert(schema.channels)
    .values({ ownerId: u.id, slug: name, displayName: name })
    .returning({ id: schema.channels.id });
  if (!c) throw new Error("no channel");
  if (opts.live ?? true) await liveBroadcast(c.id);
  return { userId: u.id, channelId: c.id };
}

async function liveBroadcast(channelId: string) {
  await admin()
    .insert(schema.broadcasts)
    .values({
      channelId,
      kind: "live",
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      startedAt: new Date(Date.now() - 600_000),
      endedAt: new Date(),
    });
}

const getPaid = async (channelId: string, payouts?: boolean) =>
  (await readSetupState(app(), channelId, true, payouts)).steps.find((s) => s.step === "get_paid");

describe("get_paid", () => {
  test("does not apply before the first live stream", async () => {
    const { channelId } = await freshChannel({ live: false });
    expect((await getPaid(channelId))?.done).toBeNull();
    await liveBroadcast(channelId);
    expect(await getPaid(channelId)).toEqual({ step: "get_paid", done: false, optional: true });
  });

  test("does not apply on an instance without payouts, even when ready", async () => {
    const { userId, channelId } = await freshChannel();
    await admin().insert(schema.payoutAccounts).values({ userId, provider: "manual", payoutsEnabled: true });
    expect((await getPaid(channelId, false))?.done).toBeNull();
    expect((await getPaid(channelId, true))?.done).toBe(true);
  });

  test("manual: open while the treasurer has not enabled payouts, done once enabled", async () => {
    const { userId, channelId } = await freshChannel();
    await admin().insert(schema.payoutAccounts).values({ userId, provider: "manual", payoutsEnabled: false });
    expect((await getPaid(channelId))?.done).toBe(false);
    await admin()
      .update(schema.payoutAccounts)
      .set({ payoutsEnabled: true, providerAccountId: "ref-1" })
      .where(eq(schema.payoutAccounts.userId, userId));
    expect((await getPaid(channelId))?.done).toBe(true);
  });

  test("Stripe: a Connect account still onboarding is open, payouts_enabled is done", async () => {
    const { userId, channelId } = await freshChannel();
    await admin()
      .insert(schema.payoutAccounts)
      .values({ userId, provider: "stripe", providerAccountId: "acct_test", payoutsEnabled: false });
    expect((await getPaid(channelId))?.done).toBe(false);
    await admin()
      .update(schema.payoutAccounts)
      .set({ payoutsEnabled: true })
      .where(eq(schema.payoutAccounts.userId, userId));
    expect((await getPaid(channelId))?.done).toBe(true);
  });

  test("another user's ready account does not tick this channel's step", async () => {
    const mine = await freshChannel();
    const theirs = await freshChannel();
    await admin()
      .insert(schema.payoutAccounts)
      .values({ userId: theirs.userId, provider: "manual", payoutsEnabled: true });
    expect((await getPaid(mine.channelId))?.done).toBe(false);
  });

  test("the owner's mark ticks it without an account", async () => {
    const { channelId } = await freshChannel();
    await markSetupStep(app(), channelId, "get_paid");
    expect((await getPaid(channelId))?.done).toBe(true);
  });

  test("an open Get paid never blocks complete", async () => {
    const { channelId } = await freshChannel();
    const [cat] = await admin()
      .insert(schema.categories)
      .values({ slug: `cat-${uuidv7()}`, name: "Painting" })
      .returning({ id: schema.categories.id });
    await admin()
      .update(schema.channels)
      .set({ description: "Hi", title: "Live", categoryId: cat?.id })
      .where(eq(schema.channels.id, channelId));
    await admin().insert(schema.streamKeys).values({ channelId, keyHash: uuidv7(), prefix: "pqrs" });
    await markSetupStep(app(), channelId, "bring_your_audience");
    const s = await readSetupState(app(), channelId, true);
    expect(s.steps.find((x) => x.step === "get_paid")?.done).toBe(false);
    expect(s.complete).toBe(true);
  });
});

describe("the route", () => {
  test("the owner marks get_paid after going live", async () => {
    const [c] = await admin()
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.slug, owner.username));
    if (!c) throw new Error("no channel");
    const path = `/api/channels/${owner.username}/setup`;
    const before = await owner.client.call<StreamSetupState>("GET", path);
    expect(before.status).toBe(200);
    expect(before.body.steps.find((s) => s.step === "get_paid")).toMatchObject({ done: null, optional: true });
    await liveBroadcast(c.id);
    const open = await owner.client.call<StreamSetupState>("GET", path);
    expect(open.body.steps.find((s) => s.step === "get_paid")?.done).toBe(false);
    const r = await owner.client.call<{ ok: boolean }>("PUT", `${path}/get_paid`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await owner.client.call<StreamSetupState>("GET", path);
    expect(after.body.steps.find((s) => s.step === "get_paid")?.done).toBe(true);
  });
});
