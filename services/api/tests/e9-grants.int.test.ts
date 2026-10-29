// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer/grants.ts` (contract step §4, ADR 0027): each revocation scope touches only its own
 * tokens, a token is never revoked twice, webhook subscriptions of other grants stay, and the
 * control messages parse as `UserControlMessage` (best effort: a failed publish is logged).
 */
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS, UserControlMessage } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { sha256Hex } from "@commonair/tokens";
import type { Deps } from "../src/deps.ts";
import {
  publishRevocations,
  revokeTokensInTx,
  revokeWebhookSubscriptionsInTx,
  type RevokedToken,
} from "../src/developer/grants.ts";
import { startApi, subscriber, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;

beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const appDb = () => api.deps.db;
const rand = () => uuidv7().replace(/-/g, "").slice(-12);

async function newUser(): Promise<string> {
  const name = `e9g_${rand()}`;
  const [u] = await db()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: schema.users.id });
  return u!.id;
}

async function newApp(ownerId: string): Promise<string> {
  const [a] = await db()
    .insert(schema.oauthApps)
    .values({
      ownerId,
      name: "grants",
      clientId: `cid_${rand()}`,
      clientSecretHash: "hash",
      redirectUris: ["https://app.example.test/cb"],
    })
    .returning({ id: schema.oauthApps.id });
  return a!.id;
}

async function token(appId: string, userId: string | null, familyId: string | null = null): Promise<string> {
  const [row] = await db()
    .insert(schema.oauthTokens)
    .values({
      appId,
      userId,
      kind: userId === null ? "client_credentials" : "authorization_code",
      scopes: userId === null ? [] : ["chat:read"],
      accessTokenHash: await sha256Hex(`at_${rand()}`),
      ...(familyId
        ? {
            familyId,
            refreshTokenHash: await sha256Hex(`rt_${rand()}`),
            refreshExpiresAt: new Date(Date.now() + 86_400_000),
          }
        : {}),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: schema.oauthTokens.id });
  return row!.id;
}

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

const revokedIds = async (ids: string[]) =>
  (
    await db()
      .select({ id: schema.oauthTokens.id, revokedAt: schema.oauthTokens.revokedAt })
      .from(schema.oauthTokens)
      .where(inArray(schema.oauthTokens.id, ids))
  )
    .filter((r) => r.revokedAt !== null)
    .map((r) => r.id)
    .sort();

describe("revokeTokensInTx", () => {
  test("each scope revokes only its tokens, and never twice", async () => {
    const owner = await newUser();
    const [u1, u2] = [await newUser(), await newUser()];
    const app = await newApp(owner);
    const other = await newApp(owner);
    const fam = uuidv7();
    const t1 = await token(app, u1, fam);
    const t1b = await token(app, u1);
    const t2 = await token(app, u2);
    const tApp = await token(app, null);
    const tOther = await token(other, u1);
    const all = [t1, t1b, t2, tApp, tOther];
    const now = new Date();

    const byIds = await appDb().transaction((tx) => revokeTokensInTx(tx, { tokenIds: [t1b] }, now));
    expect(byIds.map((t) => t.id)).toEqual([t1b]);
    expect(await appDb().transaction((tx) => revokeTokensInTx(tx, { tokenIds: [] }, now))).toEqual([]);

    const byFamily = await appDb().transaction((tx) => revokeTokensInTx(tx, { familyId: fam }, now));
    expect(byFamily.map((t) => t.id)).toEqual([t1]);
    expect(await revokedIds(all)).toEqual([t1, t1b].sort());

    const grant = await appDb().transaction((tx) => revokeTokensInTx(tx, { appId: app, userId: u1 }, now));
    // u1's tokens of the app are already revoked: nothing is returned twice.
    expect(grant).toEqual([]);

    const whole = await appDb().transaction((tx) => revokeTokensInTx(tx, { appId: app }, now));
    expect(whole.map((t) => t.id).sort()).toEqual([t2, tApp].sort());
    expect(whole.find((t) => t.id === tApp)).toMatchObject({ userId: null, appId: app });
    expect(await revokedIds(all)).toEqual([t1, t1b, t2, tApp].sort());
  });
});

describe("revokeWebhookSubscriptionsInTx", () => {
  test("a grant's subscriptions, or the whole app's; other grants and apps untouched", async () => {
    const owner = await newUser();
    const [u1, u2] = [await newUser(), await newUser()];
    const app = await newApp(owner);
    const other = await newApp(owner);
    const s1 = await webhook(app, u1);
    const s2 = await webhook(app, u2);
    const sOther = await webhook(other, u1);

    const grant = await appDb().transaction((tx) => revokeWebhookSubscriptionsInTx(tx, { appId: app, userId: u1 }));
    expect(grant).toEqual([s1]);
    const whole = await appDb().transaction((tx) => revokeWebhookSubscriptionsInTx(tx, { appId: app }));
    expect(whole).toEqual([s2]);
    const [o] = await db()
      .select({ status: schema.eventSubscriptions.status })
      .from(schema.eventSubscriptions)
      .where(eq(schema.eventSubscriptions.id, sOther));
    expect(o?.status).toBe("enabled");
  });
});

describe("publishRevocations", () => {
  test("one disconnect per token, then the app-wide one; every message parses", async () => {
    const appId = uuidv7();
    const userId = uuidv7();
    const tokens: RevokedToken[] = [
      { id: uuidv7(), userId, appId, accessTokenHash: "h1" },
      { id: uuidv7(), userId: null, appId, accessTokenHash: "h2" },
    ];
    const sub = subscriber();
    const got: Record<string, unknown>[] = [];
    await sub.subscribe(BUS.userControl);
    sub.on("message", (_ch, msg) => got.push(JSON.parse(msg) as Record<string, unknown>));
    try {
      await publishRevocations(api.deps, tokens, "app_suspended", { appId });
      const mine = () => got.filter((m) => m.appId === appId);
      await waitFor(async () => (mine().length >= 3 ? true : null));
      expect(mine()).toEqual([
        { op: "disconnect", userId, appId, tokenHash: "h1", reason: "app_suspended" },
        { op: "disconnect", appId, tokenHash: "h2", reason: "app_suspended" },
        { op: "disconnect", appId, reason: "app_suspended" },
      ]);
      for (const m of mine()) expect(UserControlMessage.safeParse(m).success).toBe(true);
    } finally {
      sub.disconnect();
    }
  });

  test("a grant revocation sends no app-wide message", async () => {
    const appId = uuidv7();
    const userId = uuidv7();
    const sub = subscriber();
    const got: Record<string, unknown>[] = [];
    await sub.subscribe(BUS.userControl);
    sub.on("message", (_ch, msg) => got.push(JSON.parse(msg) as Record<string, unknown>));
    try {
      await publishRevocations(api.deps, [{ id: uuidv7(), userId, appId, accessTokenHash: "h" }], "grant_revoked", {
        appId,
      });
      // A sentinel on the same channel: once it arrives, everything published before it has.
      await publishRevocations(api.deps, [], "app_removed", { appId: userId });
      await waitFor(async () => (got.some((m) => m.appId === userId) ? true : null));
      expect(got.filter((m) => m.appId === appId)).toEqual([
        { op: "disconnect", userId, appId, tokenHash: "h", reason: "grant_revoked" },
      ]);
    } finally {
      sub.disconnect();
    }
  });

  test("resolves, and logs, when the publish fails", async () => {
    const warnings: string[] = [];
    const deps: Deps = {
      ...api.deps,
      // Only `publish` is reached on this path.
      valkey: {
        publish: async () => {
          throw new Error("valkey down");
        },
      } as unknown as Deps["valkey"],
      logger: { ...api.deps.logger, warn: (msg: string) => void warnings.push(msg) } as Deps["logger"],
    };
    await expect(
      publishRevocations(
        deps,
        [{ id: uuidv7(), userId: uuidv7(), appId: null, accessTokenHash: "h" }],
        "token_revoked",
      ),
    ).resolves.toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
