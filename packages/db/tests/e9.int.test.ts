// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E9 schema (0035; ADR 0027): the developer platform's invariants are CHECK constraints, so the app
 * role cannot write an app-only token with scopes, a refresh token outside a family, a confidential
 * app without a secret, a suspension without reason or actor, a non-S256 code, or a subscription
 * whose transport fields disagree. Plus `authorizeSubscription` from `eventsub.ts`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { authorizeSubscription, notificationMessageId } from "../src/eventsub.ts";
import { uuidv7 } from "../src/ids.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
let owner: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
});

async function expectCheck(p: PromiseLike<unknown>, constraint: string): Promise<void> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected ${constraint} to refuse the write`).toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(new RegExp(constraint));
}

const rand = () => uuidv7().replace(/-/g, "").slice(-12);

async function newUser(): Promise<string> {
  const name = `e9_${rand()}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function newApp(ownerId: string): Promise<string> {
  const [a] = await app
    .insert(s.oauthApps)
    .values({
      ownerId,
      name: "e9 app",
      clientId: `cid_${rand()}`,
      clientSecretHash: "hash",
      redirectUris: ["https://app.example.test/cb"],
    })
    .returning({ id: s.oauthApps.id });
  return a!.id;
}

const hour = () => new Date(Date.now() + 3_600_000);

describe("oauth_apps", () => {
  test("confidential exactly when a secret hash is stored", async () => {
    const ownerId = await newUser();
    await expectCheck(
      app.insert(s.oauthApps).values({
        ownerId,
        name: "x",
        clientId: `cid_${rand()}`,
        clientSecretHash: null,
        redirectUris: [],
      }),
      "oauth_apps_secret_ck",
    );
    await expectCheck(
      app.insert(s.oauthApps).values({
        ownerId,
        name: "x",
        clientId: `cid_${rand()}`,
        clientSecretHash: "hash",
        confidential: false,
        redirectUris: [],
      }),
      "oauth_apps_secret_ck",
    );
    const [pub] = await app
      .insert(s.oauthApps)
      .values({ ownerId, name: "x", clientId: `cid_${rand()}`, confidential: false, redirectUris: [] })
      .returning({ id: s.oauthApps.id });
    expect(pub?.id).toBeTruthy();
  });

  test("a suspension needs its reason and its actor", async () => {
    const ownerId = await newUser();
    const id = await newApp(ownerId);
    await expectCheck(
      app.update(s.oauthApps).set({ suspendedAt: new Date(), suspendedById: ownerId }).where(eq(s.oauthApps.id, id)),
      "oauth_apps_suspension_ck",
    );
    await expectCheck(
      app.update(s.oauthApps).set({ suspendedAt: new Date(), suspendedReason: "spam" }).where(eq(s.oauthApps.id, id)),
      "oauth_apps_suspension_ck",
    );
    await app
      .update(s.oauthApps)
      .set({ suspendedAt: new Date(), suspendedReason: "spam", suspendedById: ownerId })
      .where(eq(s.oauthApps.id, id));
  });
});

describe("oauth_codes", () => {
  test("S256 only, and a family exactly when redeemed", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    const code = (over: Partial<typeof s.oauthCodes.$inferInsert> = {}) => ({
      codeHash: `code_${rand()}`,
      appId,
      userId,
      scopes: ["chat:read"],
      redirectUri: "https://app.example.test/cb",
      codeChallenge: "c".repeat(43),
      expiresAt: hour(),
      ...over,
    });
    await expectCheck(app.insert(s.oauthCodes).values(code({ codeChallengeMethod: "plain" })), "oauth_codes_s256_ck");
    await expectCheck(app.insert(s.oauthCodes).values(code({ redeemedAt: new Date() })), "oauth_codes_redeemed_ck");
    await expectCheck(app.insert(s.oauthCodes).values(code({ familyId: uuidv7() })), "oauth_codes_redeemed_ck");
    await app.insert(s.oauthCodes).values(code());
    await app.insert(s.oauthCodes).values(code({ redeemedAt: new Date(), familyId: uuidv7() }));
  });
});

describe("oauth_tokens", () => {
  const token = (over: Partial<typeof s.oauthTokens.$inferInsert>) => ({
    scopes: [] as string[],
    accessTokenHash: `at_${rand()}`,
    expiresAt: hour(),
    ...over,
  });

  test("app-only tokens are client credentials with no scopes and no refresh token", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    await expectCheck(
      app.insert(s.oauthTokens).values(token({ appId, kind: "client_credentials", scopes: ["chat:read"] })),
      "oauth_tokens_app_only_ck",
    );
    await expectCheck(
      app.insert(s.oauthTokens).values(
        token({
          appId,
          kind: "client_credentials",
          refreshTokenHash: `rt_${rand()}`,
          familyId: uuidv7(),
          refreshExpiresAt: hour(),
        }),
      ),
      "oauth_tokens_app_only_ck",
    );
    await expectCheck(
      app.insert(s.oauthTokens).values(token({ appId, userId, kind: "client_credentials" })),
      "oauth_tokens_app_only_ck",
    );
    await expectCheck(
      app.insert(s.oauthTokens).values(token({ appId, kind: "authorization_code" })),
      "oauth_tokens_app_only_ck",
    );
    await app.insert(s.oauthTokens).values(token({ appId, kind: "client_credentials" }));
  });

  test("a refresh token belongs to a family and expires", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    await expectCheck(
      app
        .insert(s.oauthTokens)
        .values(
          token({
            appId,
            userId,
            kind: "authorization_code",
            refreshTokenHash: `rt_${rand()}`,
            refreshExpiresAt: hour(),
          }),
        ),
      "oauth_tokens_family_ck",
    );
    await expectCheck(
      app
        .insert(s.oauthTokens)
        .values(
          token({ appId, userId, kind: "authorization_code", refreshTokenHash: `rt_${rand()}`, familyId: uuidv7() }),
        ),
      "oauth_tokens_refresh_expiry_ck",
    );
    await app.insert(s.oauthTokens).values(
      token({
        appId,
        userId,
        kind: "authorization_code",
        refreshTokenHash: `rt_${rand()}`,
        familyId: uuidv7(),
        refreshExpiresAt: hour(),
      }),
    );
  });

  test("personal tokens have no app, and only they", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    await expectCheck(
      app.insert(s.oauthTokens).values(token({ appId, userId, kind: "personal" })),
      "oauth_tokens_personal_ck",
    );
    await expectCheck(
      app.insert(s.oauthTokens).values(token({ userId, kind: "device_code" })),
      "oauth_tokens_personal_ck",
    );
    await app.insert(s.oauthTokens).values(token({ userId, scopes: ["chat:read"] }));
  });
});

describe("oauth_device_codes", () => {
  test("a decision carries its user and time", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    const device = (over: Partial<typeof s.oauthDeviceCodes.$inferInsert> = {}) => ({
      appId,
      deviceCodeHash: `dc_${rand()}`,
      userCodeHash: `uc_${rand()}`,
      scopes: ["chat:read"],
      expiresAt: hour(),
      ...over,
    });
    await expectCheck(
      app.insert(s.oauthDeviceCodes).values(device({ status: "approved", decidedAt: new Date() })),
      "oauth_device_codes_user_ck",
    );
    await expectCheck(
      app.insert(s.oauthDeviceCodes).values(device({ status: "approved", userId })),
      "oauth_device_codes_decided_ck",
    );
    await expectCheck(app.insert(s.oauthDeviceCodes).values(device({ userId })), "oauth_device_codes_user_ck");
    await app.insert(s.oauthDeviceCodes).values(device());
    await app.insert(s.oauthDeviceCodes).values(device({ status: "approved", userId, decidedAt: new Date() }));
  });
});

describe("event_subscriptions", () => {
  test("transport fields agree with the transport", async () => {
    const userId = await newUser();
    const sub = (over: Partial<typeof s.eventSubscriptions.$inferInsert>) => ({
      userId,
      type: "channel.follow",
      condition: { broadcaster_user_id: userId },
      transport: "webhook" as const,
      ...over,
    });
    await expectCheck(app.insert(s.eventSubscriptions).values(sub({})), "event_subscriptions_transport_ck");
    await expectCheck(
      app.insert(s.eventSubscriptions).values(sub({ callbackUrl: "https://hooks.example.test/cb" })),
      "event_subscriptions_transport_ck",
    );
    await expectCheck(
      app.insert(s.eventSubscriptions).values(sub({ transport: "websocket" })),
      "event_subscriptions_transport_ck",
    );
    await expectCheck(
      app
        .insert(s.eventSubscriptions)
        .values(sub({ callbackUrl: "https://hooks.example.test/cb", secretCiphertext: "c", websocketSessionId: "s1" })),
      "event_subscriptions_transport_ck",
    );
    await app
      .insert(s.eventSubscriptions)
      .values(sub({ callbackUrl: "https://hooks.example.test/cb", secretCiphertext: "c" }));
  });

  test("two WebSocket sessions may hold the same subscription", async () => {
    const userId = await newUser();
    const ws = (sessionId: string) => ({
      userId,
      type: "channel.follow",
      condition: { broadcaster_user_id: userId },
      transport: "websocket" as const,
      websocketSessionId: sessionId,
      status: "enabled" as const,
    });
    await app.insert(s.eventSubscriptions).values(ws("session-a"));
    await app.insert(s.eventSubscriptions).values(ws("session-b"));
    await expectCheck(app.insert(s.eventSubscriptions).values(ws("session-a")), "event_subscriptions_dedupe_uq");
  });
});

describe("authorizeSubscription", () => {
  test("a scoped subscription needs a live grant of an unsuspended app", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    const sub = { userId, appId, condition: { broadcaster_user_id: userId } };
    const now = new Date();
    expect(await authorizeSubscription(app, sub, "channel.subscribe", now)).toEqual({
      ok: false,
      reason: "missing authorization",
    });
    // An expired access token still backs the grant while its refresh token is good.
    await app.insert(s.oauthTokens).values({
      appId,
      userId,
      kind: "authorization_code",
      scopes: ["channel:read:subscriptions"],
      accessTokenHash: `at_${rand()}`,
      refreshTokenHash: `rt_${rand()}`,
      familyId: uuidv7(),
      refreshExpiresAt: hour(),
      expiresAt: new Date(now.getTime() - 1000),
    });
    expect(await authorizeSubscription(app, sub, "channel.subscribe", now)).toEqual({ ok: true });
    // …not once the refresh token has expired too.
    expect(await authorizeSubscription(app, sub, "channel.subscribe", new Date(now.getTime() + 7_200_000))).toEqual({
      ok: false,
      reason: "missing authorization",
    });
    await app
      .update(s.oauthApps)
      .set({ suspendedAt: now, suspendedReason: "abuse", suspendedById: userId })
      .where(eq(s.oauthApps.id, appId));
    expect(await authorizeSubscription(app, sub, "channel.subscribe", now)).toEqual({
      ok: false,
      reason: "missing authorization",
    });
  });

  test("scope-less events need no grant; another broadcaster is refused", async () => {
    const userId = await newUser();
    const other = await newUser();
    expect(
      await authorizeSubscription(
        app,
        { userId, appId: null, condition: { broadcaster_user_id: other } },
        "channel.follow",
        new Date(),
      ),
    ).toEqual({ ok: true });
    await app.insert(s.oauthTokens).values({
      userId,
      scopes: ["channel:read:subscriptions"],
      accessTokenHash: `at_${rand()}`,
      expiresAt: hour(),
    });
    expect(
      await authorizeSubscription(
        app,
        { userId, appId: null, condition: { broadcaster_user_id: other } },
        "channel.subscribe",
        new Date(),
      ),
    ).toEqual({ ok: false, reason: "subscriber is not the broadcaster" });
  });

  test("notification message ids are deterministic uuids", () => {
    expect(notificationMessageId("s", "e")).toBe(notificationMessageId("s", "e"));
    expect(notificationMessageId("s", "e")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
