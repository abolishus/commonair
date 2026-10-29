// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E9-apps over HTTP (ADR 0027 §1, §4): registering, updating, rotating and deleting OAuth apps,
 * and an admin's list, suspension and unsuspension. Suspension revokes every token and webhook
 * subscription of the app with an audit row in one transaction, then publishes `app_suspended`
 * and enqueues one revocation notice per subscription; unsuspending restores nothing.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS, UserControlMessage } from "@commonair/contracts/events";
import { OAUTH_LIMITS } from "@commonair/contracts/oauth";
import { schema, uuidv7 } from "@commonair/db";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { setWebhookQueue, type WebhookJobName } from "../src/developer/webhook-queue.ts";
import { resolveBearer } from "../src/lib/caller.ts";
import { client, signUpAndSignIn, startApi, subscriber, waitFor, type Client, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface App {
  id: string;
  name: string;
  description: string;
  clientId: string;
  redirectUris: string[];
  confidential: boolean;
  createdAt: string;
  secretRotatedAt: string | null;
  suspended: { at: string; reason: string } | null;
}
interface AdminApp extends App {
  owner: { id: string; username: string };
  grants: number;
  subscriptions: number;
}
interface Created {
  app: App;
  secret: { clientId: string; clientSecret: string } | null;
}
interface ErrorBody {
  code: string;
  data?: { requirement?: string };
}

let api: TestApi;
let owner: Account;
let other: Account;
let admin: Account;
const jobs: { name: WebhookJobName; data: Record<string, unknown>; jobId: string }[] = [];

beforeAll(async () => {
  api = await startApi();
  [owner, other, admin] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
  setWebhookQueue(api.deps, {
    async enqueue(name, data, jobId) {
      jobs.push({ name, data, jobId });
    },
    async close() {},
  });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

/** Owner connection: seeds rows the API only reads, and checks what it wrote. */
const db = () => api.db.db;
const rand = () => uuidv7().replace(/-/g, "").slice(-12);
const REDIRECT = "https://app.example.test/cb";

async function create(c: Client, body: Record<string, unknown> = {}) {
  return c.call<Created>("POST", "/api/developer/apps", { name: `app ${rand()}`, redirectUris: [REDIRECT], ...body });
}

async function createOk(c: Client, body: Record<string, unknown> = {}): Promise<Created> {
  const r = await create(c, body);
  if (r.status !== 200) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function appRow(id: string) {
  const [row] = await db().select().from(schema.oauthApps).where(eq(schema.oauthApps.id, id));
  return row;
}

async function newUser(): Promise<string> {
  const name = `e9a_${rand()}`;
  const [u] = await db()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name, emailVerified: true })
    .returning({ id: schema.users.id });
  return u!.id;
}

async function token(
  appId: string,
  userId: string | null,
  opts: { expired?: boolean; revoked?: boolean } = {},
): Promise<{ raw: string; id: string }> {
  const raw = randomSecret("ca_", 24);
  const past = new Date(Date.now() - 60_000);
  const [row] = await db()
    .insert(schema.oauthTokens)
    .values({
      appId,
      userId,
      kind: userId === null ? "client_credentials" : "authorization_code",
      scopes: userId === null ? [] : ["chat:read"],
      accessTokenHash: await sha256Hex(raw),
      expiresAt: opts.expired ? past : new Date(Date.now() + 3_600_000),
      revokedAt: opts.revoked ? past : null,
    })
    .returning({ id: schema.oauthTokens.id });
  return { raw, id: row!.id };
}

async function subscription(
  appId: string,
  userId: string,
  opts: { transport?: "webhook" | "websocket"; status?: "enabled" | "revoked" } = {},
): Promise<string> {
  const ws = opts.transport === "websocket";
  const [row] = await db()
    .insert(schema.eventSubscriptions)
    .values({
      appId,
      userId,
      type: "channel.follow",
      condition: { broadcaster_user_id: userId },
      transport: ws ? "websocket" : "webhook",
      callbackUrl: ws ? null : `https://hooks.example.test/${rand()}`,
      secretCiphertext: ws ? null : "c",
      websocketSessionId: ws ? `s_${rand()}` : null,
      status: opts.status ?? "enabled",
    })
    .returning({ id: schema.eventSubscriptions.id });
  return row!.id;
}

/** Collects BUS.userControl messages for `appId` while `fn` runs, until `until` holds. */
async function captureControl(
  appId: string,
  fn: () => Promise<unknown>,
  until: (msgs: Record<string, unknown>[]) => boolean,
): Promise<Record<string, unknown>[]> {
  const sub = subscriber();
  const got: Record<string, unknown>[] = [];
  await sub.subscribe(BUS.userControl);
  sub.on("message", (_ch, msg) => got.push(JSON.parse(msg) as Record<string, unknown>));
  try {
    await fn();
    const mine = () => got.filter((m) => m.appId === appId);
    await waitFor(async () => (until(mine()) ? true : null));
    for (const m of mine()) expect(UserControlMessage.safeParse(m).success).toBe(true);
    return mine();
  } finally {
    sub.disconnect();
  }
}

describe("apps.create and apps.list", () => {
  test("a confidential app: the secret once, its sha256 stored", async () => {
    const { app, secret } = await createOk(owner.client, {
      name: "  Spaced name  ",
      description: " a bot ",
      redirectUris: [REDIRECT, "http://127.0.0.1/cb", REDIRECT],
    });
    expect(app).toMatchObject({
      name: "Spaced name",
      description: "a bot",
      confidential: true,
      suspended: null,
      secretRotatedAt: null,
      redirectUris: [REDIRECT, "http://127.0.0.1/cb"],
    });
    expect(app.clientId).toMatch(/^[a-z0-9]{30}$/);
    expect(secret?.clientId).toBe(app.clientId);
    expect(secret?.clientSecret).toMatch(/^cas_[0-9a-f]{64}$/);
    const row = await appRow(app.id);
    expect(row?.clientSecretHash).toBe(await sha256Hex(secret!.clientSecret));
    expect(row?.ownerId).toBe(owner.userId);

    const list = await owner.client.call<App[]>("GET", "/api/developer/apps");
    expect(list.status).toBe(200);
    const listed = list.body.find((a) => a.id === app.id);
    expect(listed).toEqual(app);
    // The secret and its hash never come back.
    expect(JSON.stringify(list.body)).not.toContain(secret!.clientSecret);
    expect(JSON.stringify(list.body)).not.toContain(row!.clientSecretHash!);
  });

  test("a public app has no secret and no hash", async () => {
    const { app, secret } = await createOk(owner.client, { confidential: false });
    expect(secret).toBeNull();
    expect(app.confidential).toBe(false);
    expect((await appRow(app.id))?.clientSecretHash).toBeNull();
  });

  test("newest first, and only the caller's", async () => {
    const a = await createOk(other.client);
    const b = await createOk(other.client);
    const list = await other.client.call<App[]>("GET", "/api/developer/apps");
    const ids = list.body.map((x) => x.id);
    expect(ids.indexOf(b.app.id)).toBeLessThan(ids.indexOf(a.app.id));
    const mine = await owner.client.call<App[]>("GET", "/api/developer/apps");
    expect(mine.body.some((x) => x.id === a.app.id)).toBe(false);
  });

  test("a blank name, a bad redirect URI or no session is refused", async () => {
    expect((await create(owner.client, { name: "   " })).status).toBe(400);
    expect((await create(owner.client, { redirectUris: ["http://example.test/cb"] })).status).toBe(400);
    expect((await create(owner.client, { redirectUris: [] })).status).toBe(400);
    expect((await create(client(api))).status).toBe(401);
  });

  test("an access token cannot manage apps (session only)", async () => {
    const appId = (await createOk(owner.client)).app.id;
    const t = await token(appId, owner.userId);
    const r = await client(api, { bearer: t.raw }).call("GET", "/api/developer/apps");
    expect(r.status).toBe(403);
  });

  test(`at most ${OAUTH_LIMITS.appsPerUser} apps per owner`, async () => {
    const dev = await signUpAndSignIn(api);
    await db()
      .insert(schema.oauthApps)
      .values(
        Array.from({ length: OAUTH_LIMITS.appsPerUser - 1 }, (_, i) => ({
          ownerId: dev.userId,
          name: `seed ${i}`,
          clientId: `seed${rand()}${i}`,
          confidential: false,
          redirectUris: [REDIRECT],
        })),
      );
    await createOk(dev.client);
    const r = await create(dev.client);
    expect(r.status).toBe(412);
    expect((r.body as unknown as ErrorBody).data?.requirement).toBe("app_limit");
  });
});

describe("apps.update, rotateSecret and remove", () => {
  test("someone else's app is NOT_FOUND, never FORBIDDEN", async () => {
    const { app } = await createOk(owner.client);
    expect((await other.client.call("PATCH", `/api/developer/apps/${app.id}`, { name: "x" })).status).toBe(404);
    expect((await other.client.call("POST", `/api/developer/apps/${app.id}/secret`)).status).toBe(404);
    expect((await other.client.call("DELETE", `/api/developer/apps/${app.id}`)).status).toBe(404);
    expect((await owner.client.call("PATCH", `/api/developer/apps/${uuidv7()}`, { name: "x" })).status).toBe(404);
    expect(await appRow(app.id)).toBeDefined();
  });

  test("update changes what it is given; tokens survive a redirect change", async () => {
    const { app } = await createOk(owner.client);
    const t = await token(app.id, owner.userId);
    const r = await owner.client.call<App>("PATCH", `/api/developer/apps/${app.id}`, {
      description: "new description",
      redirectUris: ["https://other.example.test/cb"],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name: app.name,
      description: "new description",
      redirectUris: ["https://other.example.test/cb"],
    });
    expect(await resolveBearer(api.deps, t.raw)).not.toBeNull();
    const same = await owner.client.call<App>("PATCH", `/api/developer/apps/${app.id}`, {});
    expect(same.body).toEqual(r.body);
  });

  test("rotation replaces the hash at once and keeps tokens", async () => {
    const { app, secret } = await createOk(owner.client);
    const t = await token(app.id, owner.userId);
    const r = await owner.client.call<{ clientId: string; clientSecret: string }>(
      "POST",
      `/api/developer/apps/${app.id}/secret`,
    );
    expect(r.status).toBe(200);
    expect(r.body.clientId).toBe(app.clientId);
    expect(r.body.clientSecret).toMatch(/^cas_[0-9a-f]{64}$/);
    expect(r.body.clientSecret).not.toBe(secret!.clientSecret);
    const row = await appRow(app.id);
    expect(row?.clientSecretHash).toBe(await sha256Hex(r.body.clientSecret));
    expect(row?.secretRotatedAt).not.toBeNull();
    expect(await resolveBearer(api.deps, t.raw)).not.toBeNull();
    const listed = (await owner.client.call<App[]>("GET", "/api/developer/apps")).body.find((a) => a.id === app.id);
    expect(listed?.secretRotatedAt).not.toBeNull();
  });

  test("a public app has no secret to rotate", async () => {
    const { app } = await createOk(owner.client, { confidential: false });
    const r = await owner.client.call<ErrorBody>("POST", `/api/developer/apps/${app.id}/secret`);
    expect(r.status).toBe(412);
    expect(r.body.data?.requirement).toBe("public_client");
  });

  test("a suspended app cannot be updated or rotated", async () => {
    const { app } = await createOk(owner.client);
    await db()
      .update(schema.oauthApps)
      .set({ suspendedAt: new Date(), suspendedReason: "spam", suspendedById: admin.userId })
      .where(eq(schema.oauthApps.id, app.id));
    const u = await owner.client.call<ErrorBody>("PATCH", `/api/developer/apps/${app.id}`, { name: "new" });
    expect(u.status).toBe(412);
    expect(u.body.data?.requirement).toBe("app_suspended");
    const s = await owner.client.call<ErrorBody>("POST", `/api/developer/apps/${app.id}/secret`);
    expect(s.status).toBe(412);
    expect(s.body.data?.requirement).toBe("app_suspended");
    expect((await appRow(app.id))?.name).toBe(app.name);
  });

  test("remove cascades everything and publishes app_removed", async () => {
    const { app } = await createOk(owner.client);
    const user = await newUser();
    const t1 = await token(app.id, user);
    const t2 = await token(app.id, null);
    const subId = await subscription(app.id, user);
    await subscription(app.id, user, { transport: "websocket" });
    await db()
      .insert(schema.webhookDeliveries)
      .values({ subscriptionId: subId, eventId: uuidv7(), messageId: uuidv7() });
    await db()
      .insert(schema.oauthCodes)
      .values({
        codeHash: await sha256Hex(`cac_${rand()}`),
        appId: app.id,
        userId: user,
        scopes: ["chat:read"],
        redirectUri: REDIRECT,
        codeChallenge: "x".repeat(43),
        expiresAt: new Date(Date.now() + 60_000),
      });
    await db()
      .insert(schema.oauthDeviceCodes)
      .values({
        appId: app.id,
        deviceCodeHash: await sha256Hex(`cad_${rand()}`),
        userCodeHash: await sha256Hex(rand()),
        scopes: [],
        expiresAt: new Date(Date.now() + 600_000),
      });

    const msgs = await captureControl(
      app.id,
      async () => expect((await owner.client.call("DELETE", `/api/developer/apps/${app.id}`)).status).toBe(200),
      (m) => m.some((x) => x.tokenHash === undefined),
    );
    const hashes = new Set([await sha256Hex(t1.raw), await sha256Hex(t2.raw)]);
    expect(msgs.filter((m) => typeof m.tokenHash === "string").map((m) => m.tokenHash)).toHaveLength(2);
    for (const m of msgs.filter((x) => typeof x.tokenHash === "string"))
      expect(hashes.has(m.tokenHash as string)).toBe(true);
    expect(msgs.at(-1)).toEqual({ op: "disconnect", appId: app.id, reason: "app_removed" });

    expect(await appRow(app.id)).toBeUndefined();
    const left = await Promise.all([
      db().select().from(schema.oauthTokens).where(eq(schema.oauthTokens.appId, app.id)),
      db().select().from(schema.oauthCodes).where(eq(schema.oauthCodes.appId, app.id)),
      db().select().from(schema.oauthDeviceCodes).where(eq(schema.oauthDeviceCodes.appId, app.id)),
      db().select().from(schema.eventSubscriptions).where(eq(schema.eventSubscriptions.appId, app.id)),
      db().select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.subscriptionId, subId)),
    ]);
    expect(left.map((rows) => rows.length)).toEqual([0, 0, 0, 0, 0]);
    expect(await resolveBearer(api.deps, t1.raw)).toBeNull();
    // Nothing to tell webhook receivers: their subscription rows are gone.
    expect(jobs.some((j) => j.data.subscriptionId === subId)).toBe(false);
    expect((await owner.client.call("DELETE", `/api/developer/apps/${app.id}`)).status).toBe(404);
  });
});

describe("developer.admin", () => {
  test("non-admins are refused", async () => {
    const { app } = await createOk(owner.client);
    expect((await owner.client.call("GET", "/api/admin/apps")).status).toBe(403);
    expect((await owner.client.call("POST", `/api/admin/apps/${app.id}/suspend`, { reason: "abuse" })).status).toBe(
      403,
    );
    expect((await other.client.call("POST", `/api/admin/apps/${app.id}/unsuspend`)).status).toBe(403);
    expect((await appRow(app.id))?.suspendedAt).toBeNull();
  });

  test("list: search, suspended filter, counts and keyset pages", async () => {
    const tag = `Tagged${rand()}`;
    const dev = await signUpAndSignIn(api);
    const a = await createOk(dev.client, { name: `${tag} one` });
    const b = await createOk(dev.client, { name: `zz ${tag.toLowerCase()} two` });
    const c = await createOk(dev.client, { name: `${tag} three`, confidential: false });
    await db()
      .update(schema.oauthApps)
      .set({ suspendedAt: new Date(), suspendedReason: "other", suspendedById: admin.userId })
      .where(eq(schema.oauthApps.id, c.app.id));

    // a: two users with live grants (one through a refreshable token), plus a revoked, an
    // expired and an app-only token that do not count; one enabled webhook.
    const [u1, u2, u3, u4] = await Promise.all([newUser(), newUser(), newUser(), newUser()]);
    await token(a.app.id, u1);
    await token(a.app.id, u1);
    await db()
      .insert(schema.oauthTokens)
      .values({
        appId: a.app.id,
        userId: u2,
        kind: "authorization_code",
        scopes: ["chat:read"],
        accessTokenHash: await sha256Hex(`at_${rand()}`),
        refreshTokenHash: await sha256Hex(`rt_${rand()}`),
        refreshExpiresAt: new Date(Date.now() + 86_400_000),
        familyId: uuidv7(),
        expiresAt: new Date(Date.now() - 60_000),
      });
    await token(a.app.id, u3, { revoked: true });
    await token(a.app.id, u4, { expired: true });
    await token(a.app.id, null);
    await subscription(a.app.id, u1);
    await subscription(a.app.id, u2, { status: "revoked" });
    await subscription(a.app.id, u1, { transport: "websocket" });

    type Page = { items: AdminApp[]; nextCursor: string | null };
    const search = (query: string) => admin.client.call<Page>("GET", `/api/admin/apps?${query}`);

    const all = await search(`q=${encodeURIComponent(tag.toLowerCase())}`);
    expect(all.status).toBe(200);
    expect(all.body.items.map((x) => x.id)).toEqual([c.app.id, b.app.id, a.app.id]);
    const first = all.body.items.find((x) => x.id === a.app.id);
    expect(first).toMatchObject({
      owner: { id: dev.userId, username: dev.username },
      grants: 2,
      subscriptions: 1,
      suspended: null,
    });
    expect(all.body.items.find((x) => x.id === c.app.id)?.suspended?.reason).toBe("other");
    expect(JSON.stringify(all.body)).not.toContain("clientSecretHash");

    const byClientId = await search(`q=${b.app.clientId}`);
    expect(byClientId.body.items.map((x) => x.id)).toEqual([b.app.id]);
    // A client id matches exactly, not as a substring.
    expect((await search(`q=${b.app.clientId.slice(0, 29)}x`)).body.items).toEqual([]);
    // LIKE wildcards are literal.
    expect((await search(`q=${encodeURIComponent("%")}${tag}`)).body.items).toEqual([]);

    const suspended = await search(`q=${tag}&suspended=true`);
    expect(suspended.body.items.map((x) => x.id)).toEqual([c.app.id]);
    const active = await search(`q=${tag}&suspended=false`);
    expect(active.body.items.map((x) => x.id)).toEqual([b.app.id, a.app.id]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const p: Page = (await search(`q=${tag}&limit=1${cursor ? `&cursor=${cursor}` : ""}`)).body;
      seen.push(...p.items.map((x) => x.id));
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([c.app.id, b.app.id, a.app.id]);
    expect((await search("cursor=garbage")).status).toBe(400);
  });

  test("suspend revokes tokens and webhooks, audits, notifies; unsuspend restores nothing", async () => {
    const { app } = await createOk(owner.client);
    const [u1, u2] = await Promise.all([newUser(), newUser()]);
    const t1 = await token(app.id, u1);
    const t2 = await token(app.id, u2);
    const tApp = await token(app.id, null);
    const s1 = await subscription(app.id, u1);
    const s2 = await subscription(app.id, u2);
    const sWs = await subscription(app.id, u1, { transport: "websocket" });
    const otherApp = (await createOk(other.client)).app.id;
    const tOther = await token(otherApp, u1);
    const sOther = await subscription(otherApp, u1);

    let res: { status: number; body: AdminApp } | undefined;
    const msgs = await captureControl(
      app.id,
      async () => {
        res = await admin.client.call<AdminApp>("POST", `/api/admin/apps/${app.id}/suspend`, { reason: "abuse" });
      },
      (m) => m.some((x) => x.tokenHash === undefined),
    );
    expect(res?.status).toBe(200);
    expect(res?.body).toMatchObject({ id: app.id, grants: 0, subscriptions: 0, suspended: { reason: "abuse" } });

    // Tokens: dead at once, and revoked in the database.
    for (const t of [t1, t2, tApp]) expect(await resolveBearer(api.deps, t.raw)).toBeNull();
    expect(await resolveBearer(api.deps, tOther.raw)).not.toBeNull();
    const tokens = await db()
      .select({ id: schema.oauthTokens.id, revokedAt: schema.oauthTokens.revokedAt })
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.appId, app.id));
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    // Webhook subscriptions revoked (WebSocket rows are E9-ws's to close), others untouched.
    const subs = await db()
      .select({ id: schema.eventSubscriptions.id, status: schema.eventSubscriptions.status })
      .from(schema.eventSubscriptions)
      .where(inArray(schema.eventSubscriptions.id, [s1, s2, sWs, sOther]));
    const status = Object.fromEntries(subs.map((s) => [s.id, s.status]));
    expect(status).toEqual({ [s1]: "revoked", [s2]: "revoked", [sWs]: "enabled", [sOther]: "enabled" });

    // One revocation notice per revoked webhook subscription.
    const notices = jobs.filter(
      (j) => j.name === "revocation" && [s1, s2, sWs].includes(j.data.subscriptionId as string),
    );
    expect(new Set(notices.map((j) => j.data.subscriptionId))).toEqual(new Set([s1, s2]));
    expect(notices).toHaveLength(2);
    for (const j of notices) expect(j.jobId).toBe(`revocation-${j.data.subscriptionId as string}`);

    // Control messages: one per token, then the app-wide one.
    expect(msgs.filter((m) => typeof m.tokenHash === "string")).toHaveLength(3);
    expect(msgs.every((m) => m.reason === "app_suspended")).toBe(true);
    expect(msgs.at(-1)).toEqual({ op: "disconnect", appId: app.id, reason: "app_suspended" });

    // The audit row: ids and enums only.
    const [row] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "oauth_app"), eq(schema.auditLog.subjectId, app.id)));
    expect(row).toMatchObject({
      actorType: "admin",
      actorId: admin.userId,
      action: "developer.app.suspend",
      reason: "",
      details: { reason: "abuse", tokens: 3, subscriptions: 2 },
    });
    expect((await appRow(app.id))?.suspendedById).toBe(admin.userId);

    // Twice is a conflict; the owner cannot change it meanwhile.
    expect((await admin.client.call("POST", `/api/admin/apps/${app.id}/suspend`, { reason: "spam" })).status).toBe(409);
    expect((await owner.client.call("PATCH", `/api/developer/apps/${app.id}`, { name: "x" })).status).toBe(412);
    const ownerView = (await owner.client.call<App[]>("GET", "/api/developer/apps")).body.find((a) => a.id === app.id);
    expect(ownerView?.suspended?.reason).toBe("abuse");

    // Unsuspend: the suspension goes, the revocations stay.
    const un = await admin.client.call<AdminApp>("POST", `/api/admin/apps/${app.id}/unsuspend`);
    expect(un.status).toBe(200);
    expect(un.body.suspended).toBeNull();
    const after = await appRow(app.id);
    expect([after?.suspendedAt, after?.suspendedReason, after?.suspendedById]).toEqual([null, null, null]);
    for (const t of [t1, t2, tApp]) expect(await resolveBearer(api.deps, t.raw)).toBeNull();
    const [still] = await db()
      .select({ status: schema.eventSubscriptions.status })
      .from(schema.eventSubscriptions)
      .where(eq(schema.eventSubscriptions.id, s1));
    expect(still?.status).toBe("revoked");
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "oauth_app"), eq(schema.auditLog.subjectId, app.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(["developer.app.suspend", "developer.app.unsuspend"]);
    expect(audits.find((a) => a.action === "developer.app.unsuspend")?.reason).toBe("");

    expect((await admin.client.call("POST", `/api/admin/apps/${app.id}/unsuspend`)).status).toBe(409);
    expect((await owner.client.call("PATCH", `/api/developer/apps/${app.id}`, { name: "back" })).status).toBe(200);
  });

  test("an unknown app is NOT_FOUND", async () => {
    expect((await admin.client.call("POST", `/api/admin/apps/${uuidv7()}/suspend`, { reason: "abuse" })).status).toBe(
      404,
    );
    expect((await admin.client.call("POST", `/api/admin/apps/${uuidv7()}/unsuspend`)).status).toBe(404);
  });
});
