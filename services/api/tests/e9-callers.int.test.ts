// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E9 caller resolution (contract step §3.1, ADR 0027): user tokens resolve to a `Caller`, app-only
 * (client credentials) tokens to an `AppCaller`, and a suspended app's or a revoked token to
 * nothing. Rate limits: an app's user token is its own subject (`g:`), an app token is `a:`, and
 * every request an app makes also counts against its `app` bucket.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { resolveBearer, resolveToken } from "../src/lib/caller.ts";
import { client, startApi, type TestApi } from "./harness.ts";

const APP_LIMIT = 6;
let api: TestApi;

beforeAll(async () => {
  api = await startApi({ rateLimits: { app: { max: APP_LIMIT, windowMs: 60_000 } } });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const rand = () => uuidv7().replace(/-/g, "").slice(-12);

async function newUser(): Promise<string> {
  const name = `e9c_${rand()}`;
  const [u] = await db()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name, emailVerified: true })
    .returning({ id: schema.users.id });
  return u!.id;
}

async function newApp(ownerId: string): Promise<string> {
  const [a] = await db()
    .insert(schema.oauthApps)
    .values({
      ownerId,
      name: "callers",
      clientId: `cid_${rand()}`,
      clientSecretHash: "hash",
      redirectUris: ["https://app.example.test/cb"],
    })
    .returning({ id: schema.oauthApps.id });
  return a!.id;
}

async function token(appId: string | null, userId: string | null): Promise<{ raw: string; id: string }> {
  const raw = randomSecret("ca_", 24);
  const [row] = await db()
    .insert(schema.oauthTokens)
    .values({
      appId,
      userId,
      kind: appId === null ? "personal" : userId === null ? "client_credentials" : "authorization_code",
      scopes: userId === null ? [] : ["chat:read"],
      accessTokenHash: await sha256Hex(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: schema.oauthTokens.id });
  return { raw, id: row!.id };
}

describe("resolveBearer", () => {
  test("a user token resolves to a caller; an app token to an app caller", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    const userTok = await token(appId, userId);
    const appTok = await token(appId, null);

    const u = await resolveBearer(api.deps, userTok.raw);
    expect(u && "caller" in u ? u.caller : null).toMatchObject({
      kind: "token",
      user: { id: userId },
      appId,
      tokenId: userTok.id,
      scopes: ["chat:read"],
    });
    const a = await resolveBearer(api.deps, appTok.raw);
    expect(a && "app" in a ? a.app : null).toMatchObject({ appId, tokenId: appTok.id });
    // `resolveToken` keeps its Caller-only type: an app token is not a user.
    expect(await resolveToken(api.deps, appTok.raw)).toBeNull();
    expect((await resolveToken(api.deps, userTok.raw))?.user.id).toBe(userId);
  });

  test("tokens of a suspended app, revoked tokens and unknown tokens resolve to null", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    const userTok = await token(appId, userId);
    const appTok = await token(appId, null);
    const personal = await token(null, userId);

    await db().update(schema.oauthTokens).set({ revokedAt: new Date() }).where(eq(schema.oauthTokens.id, personal.id));
    expect(await resolveBearer(api.deps, personal.raw)).toBeNull();
    expect(await resolveBearer(api.deps, "ca_unknown")).toBeNull();

    await db()
      .update(schema.oauthApps)
      .set({ suspendedAt: new Date(), suspendedReason: "abuse", suspendedById: userId })
      .where(eq(schema.oauthApps.id, appId));
    expect(await resolveBearer(api.deps, userTok.raw)).toBeNull();
    expect(await resolveBearer(api.deps, appTok.raw)).toBeNull();
  });
});

describe("app tokens over HTTP", () => {
  test("an app token is refused on user procedures without appTokens and on validate", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    const appTok = await token(appId, null);
    const asApp = client(api, { bearer: appTok.raw });
    expect((await asApp.call("GET", "/api/developer/tokens")).status).toBe(403);
    // `developer.events.list` admits app tokens: it answers 200 past the access check.
    expect((await asApp.call("GET", "/api/eventsub/subscriptions")).status).toBe(200);
  });
});

describe("rate limits (ADR 0027 §4)", () => {
  test("an app's user tokens and its app token share the app bucket; subjects stay apart", async () => {
    const userId = await newUser();
    const appId = await newApp(userId);
    const userTok = await token(appId, userId);
    const appTok = await token(appId, null);
    const asUser = client(api, { bearer: userTok.raw });
    const asApp = client(api, { bearer: appTok.raw });

    for (let i = 0; i < APP_LIMIT / 2; i++) {
      expect((await asUser.call("GET", "/api/oauth2/validate")).status).toBe(200);
      expect((await asApp.call("GET", "/api/eventsub/subscriptions")).status).toBe(200);
    }
    const refused = await asApp.call("GET", "/api/eventsub/subscriptions");
    expect(refused.status).toBe(429);
    expect((await asUser.call("GET", "/api/oauth2/validate")).status).toBe(429);

    const v = api.deps.valkey;
    expect(await v.exists(KEYS.rateLimit("default", `g:${appId}:${userId}`))).toBe(1);
    expect(await v.exists(KEYS.rateLimit("default", `a:${appId}`))).toBe(1);
    expect(await v.exists(KEYS.rateLimit("app", `app:${appId}`))).toBe(1);
    // The user's own (personal) traffic is a different subject and not the app's.
    expect(await v.exists(KEYS.rateLimit("default", `u:${userId}`))).toBe(0);
    const personal = await token(null, userId);
    expect((await client(api, { bearer: personal.raw }).call("GET", "/api/oauth2/validate")).status).toBe(200);
  });
});
