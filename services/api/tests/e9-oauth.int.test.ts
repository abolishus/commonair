// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E9-oauth against a real Postgres and Valkey (ADR 0027 §1-2): the authorization-code flow with
 * PKCE, code reuse, refresh rotation and reuse detection, client credentials, the device flow,
 * RFC 7009 revocation, suspended apps, consent error routing, grants and token revocation.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS, UserControlMessage } from "@commonair/contracts/events";
import { OAUTH_LIMITS, OAUTH_PATHS, normalizeUserCode, pkceChallenge } from "@commonair/contracts/oauth";
import { schema, uuidv7 } from "@commonair/db";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { setWebhookQueue, type WebhookQueue } from "../src/developer/webhook-queue.ts";
import { client, signUpAndSignIn, startApi, subscriber, waitFor, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
let streamer: Awaited<ReturnType<typeof signUpAndSignIn>>;
let other: Awaited<ReturnType<typeof signUpAndSignIn>>;
let ownerId: string;
const enqueued: { name: string; data: Record<string, unknown>; jobId: string }[] = [];
let queueFails = false;
const fakeQueue: WebhookQueue = {
  async enqueue(name, data, jobId) {
    if (queueFails) throw new Error("queue down");
    enqueued.push({ name, data, jobId });
  },
  async close() {},
};

// Control messages on BUS.userControl (pub/sub is not key-prefixed: filter by our ids).
const published: UserControlMessage[] = [];
let sub: ReturnType<typeof subscriber>;

beforeAll(async () => {
  api = await startApi();
  setWebhookQueue(api.deps, fakeQueue);
  sub = subscriber();
  await sub.subscribe(BUS.userControl);
  sub.on("message", (_channel: string, raw: string) => {
    const m = UserControlMessage.safeParse(JSON.parse(raw));
    if (m.success) published.push(m.data);
  });
  streamer = await signUpAndSignIn(api);
  other = await signUpAndSignIn(api);
  const [o] = await db()
    .insert(schema.users)
    .values({ name: "e9o owner", email: `e9o_${rand()}@example.test`, username: `e9o_${rand()}` })
    .returning({ id: schema.users.id });
  ownerId = o!.id;
}, 120_000);
afterAll(async () => {
  sub?.disconnect();
  await api?.stop();
});

const db = () => api.db.db;
const rand = () => uuidv7().replace(/-/g, "").slice(-12);

interface App {
  id: string;
  clientId: string;
  secret: string | null;
}

const LOOPBACK = "http://127.0.0.1/cb";
const HTTPS_CB = "https://app.example.test/cb?tenant=1";

async function newApp(opts: { confidential?: boolean } = {}): Promise<App> {
  const confidential = opts.confidential ?? true;
  const secret = confidential ? randomSecret("cas_", 24) : null;
  const clientId = `cid_${rand()}`;
  const [a] = await db()
    .insert(schema.oauthApps)
    .values({
      ownerId,
      name: "oauth test",
      clientId,
      confidential,
      clientSecretHash: secret === null ? null : await sha256Hex(secret),
      redirectUris: [LOOPBACK, HTTPS_CB],
    })
    .returning({ id: schema.oauthApps.id });
  return { id: a!.id, clientId, secret };
}

interface Raw {
  status: number;
  body: Record<string, unknown> | null;
  res: Response;
}

async function post(path: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Raw> {
  const res = await fetch(`${api.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null, res };
}

const withSecret = (app: App, params: Record<string, string>) =>
  app.secret === null
    ? { ...params, client_id: app.clientId }
    : { ...params, client_id: app.clientId, client_secret: app.secret };

const verifierOf = () => randomSecret("", 48);

async function authorize(
  app: App,
  as: Client,
  opts: { scopes?: string; redirectUri?: string; state?: string; verifier?: string } = {},
): Promise<{ code: string; verifier: string; redirectUri: string }> {
  const verifier = opts.verifier ?? verifierOf();
  const redirectUri = opts.redirectUri ?? "http://127.0.0.1:43123/cb";
  const r = await as.call<{ redirectTo: string }>("POST", "/api/oauth2/authorize", {
    clientId: app.clientId,
    redirectUri,
    scope: opts.scopes ?? "chat:read",
    state: opts.state ?? "st",
    codeChallenge: await pkceChallenge(verifier),
    codeChallengeMethod: "S256",
    approve: true,
  });
  expect(r.status).toBe(200);
  const url = new URL(r.body.redirectTo);
  const code = url.searchParams.get("code");
  if (!code) throw new Error(`no code: ${r.body.redirectTo}`);
  return { code, verifier, redirectUri };
}

const exchange = (app: App, a: { code: string; verifier: string; redirectUri: string }) =>
  post(
    OAUTH_PATHS.token,
    withSecret(app, {
      grant_type: "authorization_code",
      code: a.code,
      redirect_uri: a.redirectUri,
      code_verifier: a.verifier,
    }),
  );

const refresh = (app: App, refreshToken: string) =>
  post(OAUTH_PATHS.token, withSecret(app, { grant_type: "refresh_token", refresh_token: refreshToken }));

async function tokenFor(app: App, as: Client, scopes = "chat:read") {
  const r = await exchange(app, await authorize(app, as, { scopes }));
  expect(r.status).toBe(200);
  return r.body as { access_token: string; refresh_token: string; scope: string; expires_in: number };
}

const validate = (token: string) =>
  client(api, { bearer: token }).call<Record<string, unknown>>("GET", "/api/oauth2/validate");

async function tokenRow(accessToken: string) {
  const [row] = await db()
    .select()
    .from(schema.oauthTokens)
    .where(eq(schema.oauthTokens.accessTokenHash, await sha256Hex(accessToken)));
  return row!;
}

async function withClock<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = api.deps.now;
  api.deps.now = () => new Date(Date.now() + offsetMs);
  try {
    return await fn();
  } finally {
    api.deps.now = realNow;
  }
}

const messagesFor = (pred: (m: UserControlMessage) => boolean) => published.filter(pred);

describe("authorization code flow", () => {
  test("code → tokens; the token validates; scopes are the RFC string", async () => {
    const app = await newApp();
    const t = await tokenFor(app, streamer.client, "chat:read chat:edit");
    expect(t.access_token).toMatch(/^ca_[0-9a-f]{64}$/);
    expect(t.refresh_token).toMatch(/^car_[0-9a-f]{64}$/);
    expect(t.scope).toBe("chat:read chat:edit");
    expect(t.expires_in).toBe(OAUTH_LIMITS.accessTokenTtlSeconds);
    const v = await validate(t.access_token);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ client_id: app.clientId, user_id: streamer.userId, login: streamer.username });
    const row = await tokenRow(t.access_token);
    expect(row).toMatchObject({ kind: "authorization_code", appId: app.id, userId: streamer.userId });
    expect(row.familyId).not.toBeNull();
  });

  test("every token response is no-store JSON", async () => {
    const app = await newApp();
    const r = await exchange(app, await authorize(app, streamer.client));
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.res.headers.get("content-type")).toContain("application/json");
    const bad = await post(OAUTH_PATHS.token, { grant_type: "authorization_code", client_id: app.clientId });
    expect(bad.res.headers.get("cache-control")).toBe("no-store");
  });

  test("a wrong verifier is invalid_grant, and burns the code", async () => {
    const app = await newApp();
    const a = await authorize(app, streamer.client);
    const wrong = await exchange(app, { ...a, verifier: verifierOf() });
    expect(wrong.status).toBe(400);
    expect(wrong.body?.error).toBe("invalid_grant");
    expect((await exchange(app, a)).body?.error).toBe("invalid_grant");
  });

  test("parameters in the query string work too (Twitch libraries)", async () => {
    const app = await newApp();
    const a = await authorize(app, streamer.client);
    const q = new URLSearchParams(
      withSecret(app, {
        grant_type: "authorization_code",
        code: a.code,
        redirect_uri: a.redirectUri,
        code_verifier: a.verifier,
      }),
    );
    const res = await fetch(`${api.url}${OAUTH_PATHS.token}?${q}`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("client_secret_basic authenticates; Basic plus a posted secret is invalid_request", async () => {
    const app = await newApp();
    const a = await authorize(app, streamer.client);
    const basic = `Basic ${Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.secret!)}`).toString("base64")}`;
    const both = await post(
      OAUTH_PATHS.token,
      {
        grant_type: "authorization_code",
        code: a.code,
        redirect_uri: a.redirectUri,
        code_verifier: a.verifier,
        client_secret: app.secret!,
      },
      { authorization: basic },
    );
    expect(both.body?.error).toBe("invalid_request");
    const ok = await post(
      OAUTH_PATHS.token,
      { grant_type: "authorization_code", code: a.code, redirect_uri: a.redirectUri, code_verifier: a.verifier },
      { authorization: basic },
    );
    expect(ok.status).toBe(200);
    const wrong = await post(
      OAUTH_PATHS.token,
      { grant_type: "client_credentials" },
      { authorization: `Basic ${Buffer.from(`${app.clientId}:nope`).toString("base64")}` },
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body?.error).toBe("invalid_client");
    expect(wrong.res.headers.get("www-authenticate")).toContain("Basic");
  });

  test("using a code twice is invalid_grant and revokes the first redemption's family (and publishes)", async () => {
    const app = await newApp();
    const a = await authorize(app, streamer.client);
    const first = await exchange(app, a);
    expect(first.status).toBe(200);
    const access = first.body!.access_token as string;
    const second = await exchange(app, a);
    expect(second.body?.error).toBe("invalid_grant");
    expect((await validate(access)).status).toBe(401);
    const hash = await sha256Hex(access);
    await waitFor(async () => messagesFor((m) => m.tokenHash === hash && m.reason === "token_revoked").length > 0);
  });

  test("a code expires after 60 s", async () => {
    const app = await newApp();
    const late = await authorize(app, streamer.client);
    expect((await withClock(61_000, () => exchange(app, late))).body?.error).toBe("invalid_grant");
    const inTime = await authorize(app, streamer.client);
    expect((await withClock(55_000, () => exchange(app, inTime))).status).toBe(200);
  });

  test("redirect URIs: exact match, except a loopback port; the token request must repeat the presented one", async () => {
    const app = await newApp();
    // The registered HTTPS URI with its query is accepted only exactly.
    const exact = await authorize(app, streamer.client, { redirectUri: HTTPS_CB });
    expect((await exchange(app, exact)).status).toBe(200);
    for (const redirectUri of [
      "https://app.example.test/cb",
      "https://app.example.test/cb?tenant=2",
      "http://localhost:43123/cb",
      "http://127.0.0.1:5/other",
    ]) {
      const r = await streamer.client.call<{ data?: { requirement?: string } }>("POST", "/api/oauth2/authorize", {
        clientId: app.clientId,
        redirectUri,
        scope: "chat:read",
        codeChallenge: await pkceChallenge(verifierOf()),
        codeChallengeMethod: "S256",
        approve: true,
      });
      expect(r.status).toBe(412);
      expect(r.body.data?.requirement).toBe("invalid_redirect_uri");
    }
    // Any loopback port; the exchange must name the same one.
    const a = await authorize(app, streamer.client, { redirectUri: "http://127.0.0.1:61000/cb" });
    expect((await exchange(app, { ...a, redirectUri: "http://127.0.0.1:61001/cb" })).body?.error).toBe("invalid_grant");
    const b = await authorize(app, streamer.client, { redirectUri: "http://127.0.0.1:61000/cb" });
    expect((await exchange(app, b)).status).toBe(200);
  });

  test("a code of another app is invalid_grant", async () => {
    const app = await newApp();
    const thief = await newApp();
    const a = await authorize(app, streamer.client);
    expect((await exchange(thief, a)).body?.error).toBe("invalid_grant");
  });

  test("client authentication: public with a secret, confidential without, unknown client", async () => {
    const pub = await newApp({ confidential: false });
    const a = await authorize(pub, streamer.client);
    const params = {
      grant_type: "authorization_code",
      code: a.code,
      redirect_uri: a.redirectUri,
      code_verifier: a.verifier,
    };
    const withSecretPub = await post(OAUTH_PATHS.token, { ...params, client_id: pub.clientId, client_secret: "cas_x" });
    expect(withSecretPub.status).toBe(401);
    expect(withSecretPub.body?.error).toBe("invalid_client");
    // The refused request did not consume the code: the public client redeems it bare.
    expect((await post(OAUTH_PATHS.token, { ...params, client_id: pub.clientId })).status).toBe(200);

    const conf = await newApp();
    const c = await authorize(conf, streamer.client);
    const noSecret = await post(OAUTH_PATHS.token, {
      grant_type: "authorization_code",
      code: c.code,
      redirect_uri: c.redirectUri,
      code_verifier: c.verifier,
      client_id: conf.clientId,
    });
    expect(noSecret.status).toBe(401);
    expect(noSecret.body?.error).toBe("invalid_client");
    expect(
      (await post(OAUTH_PATHS.token, { grant_type: "client_credentials", client_id: "nope", client_secret: "x" })).body
        ?.error,
    ).toBe("invalid_client");
  });

  test("bad requests: unknown grant type, missing parameters, GET", async () => {
    const app = await newApp();
    expect((await post(OAUTH_PATHS.token, withSecret(app, { grant_type: "password" }))).body?.error).toBe(
      "unsupported_grant_type",
    );
    expect((await post(OAUTH_PATHS.token, withSecret(app, {}))).body?.error).toBe("invalid_request");
    expect((await post(OAUTH_PATHS.token, withSecret(app, { grant_type: "authorization_code" }))).body?.error).toBe(
      "invalid_request",
    );
    const get = await fetch(`${api.url}${OAUTH_PATHS.token}`);
    expect(get.status).toBe(405);
  });

  test("a deleted user's code is invalid_grant", async () => {
    const app = await newApp();
    const doomed = await signUpAndSignIn(api);
    const a = await authorize(app, doomed.client);
    await db().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, doomed.userId));
    expect((await exchange(app, a)).body?.error).toBe("invalid_grant");
  });
});

describe("refresh tokens", () => {
  test("rotation: the old row is rotated and revoked, the new one shares the family", async () => {
    const app = await newApp();
    const t = await tokenFor(app, streamer.client, "chat:read chat:edit");
    const r = await refresh(app, t.refresh_token);
    expect(r.status).toBe(200);
    const next = r.body as { access_token: string; refresh_token: string; scope: string };
    expect(next.scope).toBe("chat:read chat:edit");
    const oldRow = await tokenRow(t.access_token);
    const newRow = await tokenRow(next.access_token);
    expect(oldRow.rotatedAt).not.toBeNull();
    expect(oldRow.revokedAt).not.toBeNull();
    expect(newRow.familyId).toBe(oldRow.familyId);
    expect(newRow.rotatedAt).toBeNull();
    expect((await validate(t.access_token)).status).toBe(401);
    expect((await validate(next.access_token)).status).toBe(200);
    const hash = await sha256Hex(t.access_token);
    await waitFor(async () => messagesFor((m) => m.tokenHash === hash && m.reason === "token_rotated").length > 0);
  });

  test("reusing a rotated refresh token revokes the family: the newest access token stops resolving", async () => {
    const app = await newApp();
    const t = await tokenFor(app, streamer.client);
    const r1 = (await refresh(app, t.refresh_token)).body as { access_token: string; refresh_token: string };
    const r2 = (await refresh(app, r1.refresh_token)).body as { access_token: string; refresh_token: string };
    expect((await validate(r2.access_token)).status).toBe(200);
    const replay = await refresh(app, t.refresh_token);
    expect(replay.body?.error).toBe("invalid_grant");
    expect((await validate(r2.access_token)).status).toBe(401);
    expect((await refresh(app, r2.refresh_token)).body?.error).toBe("invalid_grant");
    const hash = await sha256Hex(r2.access_token);
    await waitFor(async () => messagesFor((m) => m.tokenHash === hash && m.reason === "token_revoked").length > 0);
  });

  test("an expired refresh token, another app's refresh token and a revoked one are invalid_grant", async () => {
    const app = await newApp();
    const t = await tokenFor(app, streamer.client);
    const thief = await newApp();
    expect((await refresh(thief, t.refresh_token)).body?.error).toBe("invalid_grant");
    expect(
      (await withClock((OAUTH_LIMITS.refreshTokenTtlSeconds + 5) * 1000, () => refresh(app, t.refresh_token))).body
        ?.error,
    ).toBe("invalid_grant");
    // Still good now (expiry was only simulated), so the thief attempt revoked nothing.
    const ok = await refresh(app, t.refresh_token);
    expect(ok.status).toBe(200);
  });

  test("two concurrent refreshes of one token: one wins, the other is invalid_grant, no family revocation", async () => {
    const app = await newApp();
    const t = await tokenFor(app, streamer.client);
    const row = await tokenRow(t.access_token);
    // Hold the row so both requests read it unrotated and then queue on the CAS.
    let pending: Promise<Raw[]> = Promise.resolve([]);
    await db().transaction(async (tx) => {
      await tx.execute(sql`select id from oauth_tokens where id = ${row.id} for update`);
      pending = Promise.all([refresh(app, t.refresh_token), refresh(app, t.refresh_token)]);
      await waitFor(
        async () => {
          const [w] = (await db().execute(
            sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
          )) as unknown as { n: number }[];
          return (w?.n ?? 0) >= 2;
        },
        10_000,
        25,
      );
    });
    const results = await pending;
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 400]);
    const loser = results.find((r) => r.status === 400)!;
    expect(loser.body?.error).toBe("invalid_grant");
    const winner = results.find((r) => r.status === 200)!.body as { access_token: string };
    // The family lives on.
    expect((await validate(winner.access_token)).status).toBe(200);
    const hash = await sha256Hex(t.access_token);
    await waitFor(async () => messagesFor((m) => m.tokenHash === hash && m.reason === "token_rotated").length === 1);
    expect(messagesFor((m) => m.tokenHash === hash && m.reason === "token_revoked")).toHaveLength(0);
  });
});

describe("client credentials", () => {
  test("an app token: no user, no scopes, validate shape, user procedures refuse it", async () => {
    const app = await newApp();
    const r = await post(OAUTH_PATHS.token, withSecret(app, { grant_type: "client_credentials" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      token_type: "bearer",
      scope: "",
      expires_in: OAUTH_LIMITS.clientCredentialsTtlSeconds,
    });
    expect(r.body?.refresh_token).toBeUndefined();
    const token = r.body!.access_token as string;
    const row = await tokenRow(token);
    expect(row).toMatchObject({ userId: null, scopes: [], kind: "client_credentials", refreshTokenHash: null });
    const v = await validate(token);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ client_id: app.clientId, login: null, user_id: null, scopes: [] });
    const asApp = client(api, { bearer: token });
    expect((await asApp.call("GET", "/api/me")).status).toBe(403);
    expect((await asApp.call("POST", `/api/channels/${streamer.username}/chat/messages`, { body: "hi" })).status).toBe(
      403,
    );
    const events = await asApp.call("GET", "/api/eventsub/subscriptions");
    expect(events.status).not.toBe(401);
    expect(events.status).not.toBe(403);
  });

  test("public clients cannot; scopes are refused", async () => {
    const pub = await newApp({ confidential: false });
    expect(
      (await post(OAUTH_PATHS.token, { grant_type: "client_credentials", client_id: pub.clientId })).body?.error,
    ).toBe("unauthorized_client");
    const app = await newApp();
    expect(
      (await post(OAUTH_PATHS.token, withSecret(app, { grant_type: "client_credentials", scope: "chat:read" }))).body
        ?.error,
    ).toBe("invalid_scope");
  });
});

describe("device flow", () => {
  const start = (app: App, scope = "chat:read") => post(OAUTH_PATHS.device, withSecret(app, { scope }));
  const poll = (app: App, deviceCode: string) =>
    post(
      OAUTH_PATHS.token,
      withSecret(app, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode }),
    );
  const deviceRow = async (userCode: string) =>
    (
      await db()
        .select()
        .from(schema.oauthDeviceCodes)
        .where(eq(schema.oauthDeviceCodes.userCodeHash, await sha256Hex(normalizeUserCode(userCode))))
    )[0]!;

  test("pending, slow_down (+5 s), approve, token, then double redemption", async () => {
    const app = await newApp({ confidential: false });
    const s = await start(app, "chat:read chat:edit");
    expect(s.status).toBe(200);
    const d = s.body as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    expect(d.device_code).toMatch(/^cad_/);
    expect(d.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(d.verification_uri).toBe(`${api.deps.site.publicUrl}${OAUTH_PATHS.activatePage}`);
    expect(new URL(d.verification_uri_complete).searchParams.get("code")).toBe(d.user_code);
    expect(d).toMatchObject({
      expires_in: OAUTH_LIMITS.deviceCodeTtlSeconds,
      interval: OAUTH_LIMITS.devicePollIntervalSeconds,
    });

    expect((await poll(app, d.device_code)).body?.error).toBe("authorization_pending");
    expect((await poll(app, d.device_code)).body?.error).toBe("slow_down");
    expect((await deviceRow(d.user_code)).intervalSeconds).toBe(10);
    // Past the new interval: pending again, interval unchanged.
    expect((await withClock(11_000, () => poll(app, d.device_code))).body?.error).toBe("authorization_pending");
    expect((await deviceRow(d.user_code)).intervalSeconds).toBe(10);

    // The user looks the code up (dash and case do not matter) and approves.
    const look = await streamer.client.call<{ app: { clientId: string }; scopes: string[] }>(
      "POST",
      "/api/oauth2/activate/lookup",
      { userCode: d.user_code.toLowerCase().replace("-", "") },
    );
    expect(look.status).toBe(200);
    expect(look.body).toMatchObject({ app: { clientId: app.clientId }, scopes: ["chat:read", "chat:edit"] });
    expect(
      (await streamer.client.call("POST", "/api/oauth2/activate", { userCode: d.user_code, approve: true })).status,
    ).toBe(200);
    // A second decision is a conflict.
    expect(
      (await streamer.client.call("POST", "/api/oauth2/activate", { userCode: d.user_code, approve: false })).status,
    ).toBe(409);

    const t = await withClock(22_000, () => poll(app, d.device_code));
    expect(t.status).toBe(200);
    expect(t.body?.refresh_token).toMatch(/^car_/);
    const row = await tokenRow(t.body!.access_token as string);
    expect(row).toMatchObject({ kind: "device_code", userId: streamer.userId, scopes: ["chat:read", "chat:edit"] });
    expect(row.familyId).not.toBeNull();
    expect((await withClock(40_000, () => poll(app, d.device_code))).body?.error).toBe("invalid_grant");
  });

  test("denied → access_denied; expired → expired_token and the lookup says expired", async () => {
    const app = await newApp({ confidential: false });
    const denied = (await start(app)).body as { device_code: string; user_code: string };
    await streamer.client.call("POST", "/api/oauth2/activate", { userCode: denied.user_code, approve: false });
    expect((await poll(app, denied.device_code)).body?.error).toBe("access_denied");

    const late = (await start(app)).body as { device_code: string; user_code: string };
    const after = (OAUTH_LIMITS.deviceCodeTtlSeconds + 1) * 1000;
    expect((await withClock(after, () => poll(app, late.device_code))).body?.error).toBe("expired_token");
    const look = await withClock(after, () =>
      streamer.client.call<{ data?: { requirement?: string } }>("POST", "/api/oauth2/activate/lookup", {
        userCode: late.user_code,
      }),
    );
    expect(look.status).toBe(412);
    expect(look.body.data?.requirement).toBe("expired");
    expect(
      (
        await withClock(after, () =>
          streamer.client.call("POST", "/api/oauth2/activate", { userCode: late.user_code, approve: true }),
        )
      ).status,
    ).toBe(409);
    // Unknown is distinguishable from expired.
    expect((await streamer.client.call("POST", "/api/oauth2/activate/lookup", { userCode: "BBBB-BBBB" })).status).toBe(
      404,
    );
  });

  test("scopes: unknown and empty are invalid_scope; another app's device code is invalid_grant", async () => {
    const app = await newApp();
    expect((await start(app, "chat:read nope:nope")).body?.error).toBe("invalid_scope");
    expect((await post(OAUTH_PATHS.device, withSecret(app, {}))).body?.error).toBe("invalid_scope");
    const d = (await start(app)).body as { device_code: string };
    expect((await poll(await newApp(), d.device_code)).body?.error).toBe("invalid_grant");
    // A confidential app authenticates at the device endpoint too.
    expect((await post(OAUTH_PATHS.device, { client_id: app.clientId, scope: "chat:read" })).status).toBe(401);
  });

  test("activation takes the code in the body, and the eleventh lookup in a minute is RATE_LIMITED", async () => {
    const doc = (await (await fetch(`${api.url}/api/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
    };
    const paths = Object.keys(doc.paths).filter((p) => p.includes("activate"));
    expect(paths.sort()).toEqual(["/oauth2/activate", "/oauth2/activate/lookup"]);
    for (const p of paths) {
      expect(p).not.toContain("{");
      for (const op of Object.values(doc.paths[p]!))
        expect((op.parameters ?? []).map((x) => x.name)).not.toContain("userCode");
    }

    const me = await signUpAndSignIn(api);
    const realAuth = api.deps.rateLimits.auth;
    api.deps.rateLimits.auth = { max: 10, windowMs: 60_000 };
    try {
      for (let i = 0; i < 10; i++)
        expect((await me.client.call("POST", "/api/oauth2/activate/lookup", { userCode: "BBBB-BBBC" })).status).toBe(
          404,
        );
      const r = await me.client.call<{ code: string }>("POST", "/api/oauth2/activate/lookup", {
        userCode: "BBBB-BBBC",
      });
      expect(r.status).toBe(429);
      expect(r.body.code).toBe("RATE_LIMITED");
    } finally {
      api.deps.rateLimits.auth = realAuth;
    }
  });
});

describe("revocation endpoint (RFC 7009)", () => {
  const revoke = (app: App, token: string, hint?: string) =>
    post(OAUTH_PATHS.revoke, withSecret(app, hint ? { token, token_type_hint: hint } : { token }));

  test("an access token revokes itself; a refresh token its family; unknown tokens answer 200", async () => {
    const app = await newApp();
    const a = await tokenFor(app, streamer.client);
    const b = await tokenFor(app, streamer.client);
    const r = await revoke(app, a.access_token);
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
    expect((await validate(a.access_token)).status).toBe(401);
    expect((await validate(b.access_token)).status).toBe(200);

    const rotated = (await refresh(app, b.refresh_token)).body as { access_token: string; refresh_token: string };
    expect((await revoke(app, rotated.refresh_token, "refresh_token")).status).toBe(200);
    expect((await validate(rotated.access_token)).status).toBe(401);
    const hash = await sha256Hex(rotated.access_token);
    await waitFor(async () => messagesFor((m) => m.tokenHash === hash && m.reason === "token_revoked").length > 0);

    expect((await revoke(app, "ca_unknown")).status).toBe(200);
  });

  test("another app's token is ignored; bad client authentication is refused", async () => {
    const app = await newApp();
    const t = await tokenFor(app, streamer.client);
    const otherApp = await newApp();
    expect((await revoke(otherApp, t.access_token)).status).toBe(200);
    expect((await validate(t.access_token)).status).toBe(200);
    expect(
      (await post(OAUTH_PATHS.revoke, { token: t.access_token, client_id: app.clientId, client_secret: "x" })).status,
    ).toBe(401);
  });
});

describe("suspended apps", () => {
  test("invalid_client at every endpoint; the consent check refuses without redirecting", async () => {
    const app = await newApp();
    const a = await authorize(app, streamer.client);
    await db()
      .update(schema.oauthApps)
      .set({ suspendedAt: new Date(), suspendedReason: "abuse", suspendedById: ownerId })
      .where(eq(schema.oauthApps.id, app.id));
    expect((await exchange(app, a)).body?.error).toBe("invalid_client");
    expect((await post(OAUTH_PATHS.token, withSecret(app, { grant_type: "client_credentials" }))).body?.error).toBe(
      "invalid_client",
    );
    expect((await post(OAUTH_PATHS.revoke, withSecret(app, { token: "x" }))).body?.error).toBe("invalid_client");
    expect((await post(OAUTH_PATHS.device, withSecret(app, { scope: "chat:read" }))).body?.error).toBe(
      "invalid_client",
    );
    const r = await streamer.client.call<{ data?: { requirement?: string } }>(
      "GET",
      `/api/oauth2/authorize/request?${new URLSearchParams({ clientId: app.clientId, redirectUri: LOOPBACK, responseType: "code" })}`,
    );
    expect(r.status).toBe(412);
    expect(r.body.data?.requirement).toBe("app_suspended");
  });
});

describe("developer.oauth.request", () => {
  const request = (as: Client, q: Record<string, string>) =>
    as.call<Record<string, unknown> & { data?: { requirement?: string } }>(
      "GET",
      `/api/oauth2/authorize/request?${new URLSearchParams(q)}`,
    );

  test("client and redirect URI problems never redirect; everything else does, with state", async () => {
    const app = await newApp();
    const challenge = await pkceChallenge(verifierOf());
    const good = {
      clientId: app.clientId,
      redirectUri: "http://127.0.0.1:9999/cb",
      responseType: "code",
      scope: "chat:read",
      state: "xyz 1",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    };
    expect((await request(streamer.client, { ...good, clientId: "nope" })).status).toBe(404);
    const badUri = await request(streamer.client, { ...good, redirectUri: "https://evil.example.test/cb" });
    expect(badUri.status).toBe(412);
    expect(badUri.body.data?.requirement).toBe("invalid_redirect_uri");

    const redirected = async (q: Record<string, string>) => {
      const r = await request(streamer.client, q);
      expect(r.status).toBe(200);
      expect(r.body.kind).toBe("redirect");
      const url = new URL(r.body.redirectTo as string);
      expect(url.origin + url.pathname).toBe("http://127.0.0.1:9999/cb");
      return {
        error: url.searchParams.get("error"),
        state: url.searchParams.get("state"),
        desc: url.searchParams.get("error_description"),
      };
    };
    expect(await redirected({ ...good, responseType: "token" })).toMatchObject({
      error: "unsupported_response_type",
      state: "xyz 1",
    });
    const { codeChallenge: _c, ...noChallenge } = good;
    expect(await redirected(noChallenge)).toMatchObject({ error: "invalid_request", desc: "PKCE S256 is required" });
    expect(await redirected({ ...good, codeChallengeMethod: "plain" })).toMatchObject({ error: "invalid_request" });
    const { codeChallengeMethod: _m, ...noMethod } = good;
    expect(await redirected(noMethod)).toMatchObject({ error: "invalid_request" });
    expect(await redirected({ ...good, codeChallenge: "short" })).toMatchObject({ error: "invalid_request" });
    expect(await redirected({ ...good, scope: "chat:read bogus" })).toMatchObject({ error: "invalid_scope" });
    expect(await redirected({ ...good, scope: "" })).toMatchObject({ error: "invalid_scope" });

    const consent = await request(streamer.client, good);
    expect(consent.body).toMatchObject({
      kind: "consent",
      app: { id: app.id, clientId: app.clientId, owner: { id: ownerId } },
      scopes: ["chat:read"],
      alreadyGranted: false,
    });
  });

  test("alreadyGranted: a live grant covering every scope, unless forceVerify", async () => {
    const app = await newApp();
    await tokenFor(app, other.client, "chat:read chat:edit");
    const q = {
      clientId: app.clientId,
      redirectUri: LOOPBACK,
      responseType: "code",
      codeChallenge: await pkceChallenge(verifierOf()),
      codeChallengeMethod: "S256",
    };
    expect((await request(other.client, { ...q, scope: "chat:read" })).body.alreadyGranted).toBe(true);
    expect((await request(other.client, { ...q, scope: "chat:read", forceVerify: "true" })).body.alreadyGranted).toBe(
      false,
    );
    expect((await request(other.client, { ...q, scope: "chat:read moderator:manage:chat" })).body.alreadyGranted).toBe(
      false,
    );
    expect((await request(streamer.client, { ...q, scope: "chat:read" })).body.alreadyGranted).toBe(false);
  });

  test("decide: deny sends access_denied with state; the checks run again; tokens cannot consent", async () => {
    const app = await newApp();
    const body = {
      clientId: app.clientId,
      redirectUri: HTTPS_CB,
      scope: "chat:read",
      state: "s/1",
      codeChallenge: await pkceChallenge(verifierOf()),
      codeChallengeMethod: "S256",
    };
    const deny = await streamer.client.call<{ redirectTo: string }>("POST", "/api/oauth2/authorize", {
      ...body,
      approve: false,
    });
    const url = new URL(deny.body.redirectTo);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("s/1");
    expect(url.searchParams.get("tenant")).toBe("1");
    const bad = await streamer.client.call<{ redirectTo: string }>("POST", "/api/oauth2/authorize", {
      ...body,
      scope: "nope:nope",
      approve: true,
    });
    expect(new URL(bad.body.redirectTo).searchParams.get("error")).toBe("invalid_scope");
    const t = await tokenFor(app, streamer.client);
    expect(
      (await client(api, { bearer: t.access_token }).call("POST", "/api/oauth2/authorize", { ...body, approve: true }))
        .status,
    ).toBe(403);
  });
});

describe("grants", () => {
  async function webhook(appId: string, userId: string): Promise<string> {
    const [row] = await db()
      .insert(schema.eventSubscriptions)
      .values({
        appId,
        userId,
        type: "channel.follow",
        condition: { broadcaster_user_id: userId },
        transport: "webhook",
        callbackUrl: `https://hooks.example.test/${rand()}`,
        secretCiphertext: "c",
        status: "enabled",
      })
      .returning({ id: schema.eventSubscriptions.id });
    return row!.id;
  }
  const subStatus = async (id: string) =>
    (
      await db()
        .select({ s: schema.eventSubscriptions.status })
        .from(schema.eventSubscriptions)
        .where(eq(schema.eventSubscriptions.id, id))
    )[0]!.s;

  test("list: one entry per app, scopes the union, authorizedAt the family's first token", async () => {
    const user = await signUpAndSignIn(api);
    const app = await newApp();
    const second = await newApp();
    const t1 = await tokenFor(app, user.client, "chat:read");
    const firstRow = await tokenRow(t1.access_token);
    await refresh(app, t1.refresh_token);
    await tokenFor(app, user.client, "chat:edit");
    await tokenFor(second, user.client, "channel:read:subscriptions");
    const r = await user.client.call<
      { app: { id: string }; scopes: string[]; authorizedAt: string; lastUsedAt: string | null }[]
    >("GET", "/api/me/authorizations");
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    const g = r.body.find((x) => x.app.id === app.id)!;
    expect(g.scopes.sort()).toEqual(["chat:edit", "chat:read"]);
    expect(new Date(g.authorizedAt).getTime()).toBe(firstRow.createdAt.getTime());
    expect(r.body.find((x) => x.app.id === second.id)!.scopes).toEqual(["channel:read:subscriptions"]);
  });

  test("revoke: tokens and webhook subscriptions of that grant only, jobs enqueued, messages published", async () => {
    const user = await signUpAndSignIn(api);
    const app = await newApp();
    const keep = await newApp();
    const t = await tokenFor(app, user.client);
    const kept = await tokenFor(keep, user.client);
    const othersToken = await tokenFor(app, other.client);
    const mine = await webhook(app.id, user.userId);
    const others = await webhook(app.id, other.userId);
    const unused = await authorize(app, user.client);

    const r = await user.client.call("DELETE", `/api/me/authorizations/${app.id}`);
    expect(r.status).toBe(200);
    expect((await validate(t.access_token)).status).toBe(401);
    expect((await validate(kept.access_token)).status).toBe(200);
    expect((await validate(othersToken.access_token)).status).toBe(200);
    expect(await subStatus(mine)).toBe("revoked");
    expect(await subStatus(others)).toBe("enabled");
    expect(enqueued).toContainEqual({
      name: "revocation",
      data: { subscriptionId: mine },
      jobId: `revocation-${mine}`,
    });
    expect(enqueued.some((j) => j.data.subscriptionId === others)).toBe(false);
    // An unexchanged code cannot bring the grant back.
    expect((await exchange(app, unused)).body?.error).toBe("invalid_grant");
    await waitFor(
      async () =>
        messagesFor(
          (m) => m.appId === app.id && m.userId === user.userId && m.reason === "grant_revoked" && !m.tokenHash,
        ).length > 0,
    );
    const list = await user.client.call<{ app: { id: string } }[]>("GET", "/api/me/authorizations");
    expect(list.body.map((g) => g.app.id)).toEqual([keep.id]);
    // Idempotent, also for an app never authorized.
    expect((await user.client.call("DELETE", `/api/me/authorizations/${app.id}`)).status).toBe(200);
    expect((await user.client.call("DELETE", `/api/me/authorizations/${uuidv7()}`)).status).toBe(200);
  });

  test("with the publish and the enqueue failing, the revocation still commits and answers ok", async () => {
    const user = await signUpAndSignIn(api);
    const app = await newApp();
    const t = await tokenFor(app, user.client);
    const subId = await webhook(app.id, user.userId);
    const valkey = api.deps.valkey;
    const realPublish = valkey.publish.bind(valkey);
    (valkey as { publish: unknown }).publish = async () => {
      throw new Error("valkey down");
    };
    queueFails = true;
    try {
      const r = await user.client.call<{ ok: boolean }>("DELETE", `/api/me/authorizations/${app.id}`);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    } finally {
      (valkey as { publish: unknown }).publish = realPublish;
      queueFails = false;
    }
    expect((await validate(t.access_token)).status).toBe(401);
    expect(await subStatus(subId)).toBe("revoked");
  });

  test("grants procedures are session only", async () => {
    const app = await newApp();
    const t = await tokenFor(app, streamer.client);
    expect((await client(api, { bearer: t.access_token }).call("GET", "/api/me/authorizations")).status).toBe(403);
  });
});

describe("developer.tokens", () => {
  test("list shows appId and kind; revoke goes through the grants helpers and publishes", async () => {
    const user = await signUpAndSignIn(api);
    const app = await newApp();
    const t = await tokenFor(app, user.client);
    const row = await tokenRow(t.access_token);
    const list = await user.client.call<{ id: string; appId: string | null; kind: string }[]>(
      "GET",
      "/api/developer/tokens",
    );
    expect(list.body).toContainEqual(
      expect.objectContaining({ id: row.id, appId: app.id, kind: "authorization_code" }),
    );
    // Someone else cannot revoke it.
    expect((await other.client.call("DELETE", `/api/developer/tokens/${row.id}`)).status).toBe(404);
    expect((await user.client.call("DELETE", `/api/developer/tokens/${row.id}`)).status).toBe(200);
    expect((await validate(t.access_token)).status).toBe(401);
    expect((await user.client.call("DELETE", `/api/developer/tokens/${row.id}`)).status).toBe(404);
    await waitFor(
      async () => messagesFor((m) => m.tokenHash === row.accessTokenHash && m.reason === "token_revoked").length > 0,
    );
    const [after] = await db()
      .select()
      .from(schema.oauthTokens)
      .where(and(eq(schema.oauthTokens.id, row.id)));
    expect(after!.revokedAt).not.toBeNull();
  });
});
