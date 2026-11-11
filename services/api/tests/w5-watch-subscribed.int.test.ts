// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5 (J3-d): `channels.get` says whether the signed-in caller is subscribed, so a
 * subscribers-only chat explains itself before they type. Active and past_due count (as chat
 * counts them), a gift counts for its recipient, an ended sub does not, and anonymous callers get
 * no viewer at all.
 */
import { eq } from "drizzle-orm";
import type { SUBSCRIPTION_STATUSES } from "@commonair/contracts/enums";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Viewer = { following: boolean; portabilityGrant?: boolean; subscribed?: boolean } | null;

let api: TestApi;
let owner: User;
let channelId: string;
beforeAll(async () => {
  api = await startApi();
  owner = await signUpAndSignIn(api);
  const [c] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
  if (!c) throw new Error("no channel");
  channelId = c.id;
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

async function subscribe(
  user: User,
  status: (typeof SUBSCRIPTION_STATUSES)[number],
  extra: { giftedById?: string } = {},
): Promise<void> {
  await api.db.db.insert(schema.subscriptions).values({
    subscriberId: user.userId,
    channelId,
    tier: 1,
    status,
    provider: "manual",
    priceCents: 500,
    currency: "usd",
    ...extra,
  });
}

const viewerOf = async (user: User | null): Promise<Viewer | undefined> => {
  const c = user ? user.client : client(api);
  const r = await c.call<{ viewer?: Viewer }>("GET", `/api/channels/${owner.username}`);
  expect(r.status).toBe(200);
  return r.body.viewer;
};

describe("channels.get viewer.subscribed", () => {
  test("anonymous callers get no viewer", async () => {
    expect(await viewerOf(null)).toBeNull();
  });

  test("absent for a signed-in caller with no subscription", async () => {
    const viewer = await viewerOf(await signUpAndSignIn(api));
    expect(viewer).toMatchObject({ following: false });
    expect(viewer?.subscribed).toBeUndefined();
  });

  test("true for an active subscriber", async () => {
    const user = await signUpAndSignIn(api);
    await subscribe(user, "active");
    expect(await viewerOf(user)).toMatchObject({ subscribed: true });
  });

  test("true while past_due: chat still counts the sub during the grace period", async () => {
    const user = await signUpAndSignIn(api);
    await subscribe(user, "past_due");
    expect(await viewerOf(user)).toMatchObject({ subscribed: true });
  });

  test("absent once the sub ended (canceled, expired) or never started (incomplete)", async () => {
    for (const status of ["canceled", "expired", "incomplete"] as const) {
      const user = await signUpAndSignIn(api);
      await subscribe(user, status);
      expect((await viewerOf(user))?.subscribed, status).toBeUndefined();
    }
  });

  test("a gift counts for its recipient, not for the giver", async () => {
    const [giver, recipient] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    await subscribe(recipient, "active", { giftedById: giver.userId });
    expect(await viewerOf(recipient)).toMatchObject({ subscribed: true });
    expect((await viewerOf(giver))?.subscribed).toBeUndefined();
  });

  test("a sub to another channel does not count here", async () => {
    const [other, user] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const [c] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.slug, other.username));
    if (!c) throw new Error("no channel");
    await api.db.db.insert(schema.subscriptions).values({
      subscriberId: user.userId,
      channelId: c.id,
      tier: 1,
      status: "active",
      provider: "manual",
      priceCents: 500,
      currency: "usd",
    });
    expect((await viewerOf(user))?.subscribed).toBeUndefined();
  });
});
