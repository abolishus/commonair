// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every Subscription DTO carries its channel (slug, name, avatar, accent) the way stream cards show
 * it: `money.mySubscriptions`, `money.cancelSubscription` and the owner's `money.subscribers`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { mediaUrl } from "../src/lib/dto.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Sub = {
  id: string;
  channelSlug: string;
  channel: { slug: string; displayName: string; avatarUrl: string | null; accent?: string };
  cancelAtPeriodEnd: boolean;
};

let api: TestApi;
let themed: User;
let plain: User;
let viewer: User;

beforeAll(async () => {
  api = await startApi();
  [themed, plain, viewer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
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

async function subscribe(subscriberId: string, channelId: string) {
  const [s] = await db()
    .insert(schema.subscriptions)
    .values({
      subscriberId,
      channelId,
      tier: 1,
      status: "active",
      provider: "manual",
      priceCents: 500,
      currency: "usd",
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    })
    .returning();
  if (!s) throw new Error("no subscription");
  return s;
}

describe("Subscription.channel", () => {
  test("theme avatar and accent, or the owner's image and no accent; on every list and on cancel", async () => {
    const a = await channelOf(themed.username);
    const b = await channelOf(plain.username);
    await db()
      .update(schema.channels)
      .set({ displayName: "Themed Channel", theme: { accent: "violet", avatarKey: "avatars/themed.png" } })
      .where(eq(schema.channels.id, a.id));
    await db().update(schema.users).set({ image: "avatars/owner.png" }).where(eq(schema.users.id, plain.userId));
    const sa = await subscribe(viewer.userId, a.id);
    const sb = await subscribe(viewer.userId, b.id);

    const expectA = {
      slug: themed.username,
      displayName: "Themed Channel",
      avatarUrl: mediaUrl(api.deps, "avatars/themed.png"),
      accent: "violet",
    };
    const expectB = {
      slug: plain.username,
      displayName: b.displayName,
      avatarUrl: mediaUrl(api.deps, "avatars/owner.png"),
    };

    const mine = await viewer.client.call<Sub[]>("GET", "/api/me/subscriptions");
    expect(mine.status).toBe(200);
    const byId = new Map(mine.body.map((s) => [s.id, s]));
    expect(byId.get(sa.id)?.channel).toEqual(expectA);
    expect(byId.get(sa.id)?.channelSlug).toBe(themed.username);
    expect(byId.get(sb.id)?.channel).toEqual(expectB);
    expect(byId.get(sb.id)?.channel.accent).toBeUndefined();

    const owners = await themed.client.call<{ items: Sub[] }>("GET", `/api/channels/${themed.username}/subscriptions`);
    expect(owners.status).toBe(200);
    expect(owners.body.items.map((s) => s.channel)).toEqual([expectA]);

    const cancelled = await viewer.client.call<Sub>("POST", `/api/me/subscriptions/${sa.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancelAtPeriodEnd).toBe(true);
    expect(cancelled.body.channel).toEqual(expectA);
  });
});
