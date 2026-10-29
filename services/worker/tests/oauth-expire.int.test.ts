// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `oauth-expire` (E9-oauth, ADR 0027): codes and device codes a day past expiry, tokens 30 days
 * dead, rotated tokens kept until their refresh expiry (reuse detection), batched deletes.
 */
import { schema, uuidv7 } from "@commonair/db";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { CODE_GRACE_MS, TOKEN_GRACE_MS, expireOAuth } from "../src/jobs/oauth-expire.ts";
import { makeApp, makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(() => env.close());

const NOW = new Date("2026-10-29T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const SEC = 1000;
const DAY = 86_400_000;
const run = (batch?: number) => expireOAuth({ sql: env.worker.ctx.sql, now: () => NOW }, batch);

async function fixtures() {
  const { user } = await makeUser(env.t.db);
  const app = await makeApp(env.t.db, user.id);
  return { userId: user.id, appId: app.id };
}

async function code(appId: string, userId: string, expiresAt: Date): Promise<string> {
  const codeHash = await sha256Hex(randomSecret());
  await env.t.db.insert(schema.oauthCodes).values({
    codeHash,
    appId,
    userId,
    scopes: ["chat:read"],
    redirectUri: "https://app.example.test/cb",
    codeChallenge: "c".repeat(43),
    expiresAt,
  });
  return codeHash;
}

async function device(appId: string, expiresAt: Date): Promise<string> {
  const id = uuidv7();
  await env.t.db.insert(schema.oauthDeviceCodes).values({
    id,
    appId,
    deviceCodeHash: await sha256Hex(randomSecret()),
    userCodeHash: await sha256Hex(randomSecret()),
    scopes: ["chat:read"],
    expiresAt,
  });
  return id;
}

async function token(
  appId: string,
  userId: string,
  t: { expiresAt: Date; refreshExpiresAt?: Date; revokedAt?: Date; rotatedAt?: Date },
): Promise<string> {
  const id = uuidv7();
  const refresh = t.refreshExpiresAt !== undefined;
  await env.t.db.insert(schema.oauthTokens).values({
    id,
    appId,
    userId,
    kind: "authorization_code",
    scopes: ["chat:read"],
    accessTokenHash: await sha256Hex(randomSecret()),
    refreshTokenHash: refresh ? await sha256Hex(randomSecret()) : null,
    refreshExpiresAt: t.refreshExpiresAt ?? null,
    familyId: refresh ? uuidv7() : null,
    expiresAt: t.expiresAt,
    revokedAt: t.revokedAt ?? null,
    rotatedAt: t.rotatedAt ?? null,
  });
  return id;
}

const remaining = async <T extends { id: string } | { codeHash: string }>(
  rows: () => Promise<T[]>,
): Promise<string[]> => (await rows()).map((r) => ("id" in r ? r.id : r.codeHash)).sort();

describe("oauth-expire", () => {
  test("each retention rule at its boundary; rotated rows kept until their refresh expiry", async () => {
    const { userId, appId } = await fixtures();
    const codeOld = await code(appId, userId, at(-CODE_GRACE_MS - SEC));
    const codeEdge = await code(appId, userId, at(-CODE_GRACE_MS + SEC));
    const codeLive = await code(appId, userId, at(60 * SEC));
    const devOld = await device(appId, at(-CODE_GRACE_MS - SEC));
    const devEdge = await device(appId, at(-CODE_GRACE_MS + SEC));

    const T = TOKEN_GRACE_MS;
    // Access-only (personal-style) expired more than 30 days ago → gone; just inside → kept.
    const expiredOld = await token(appId, userId, { expiresAt: at(-T - SEC) });
    const expiredEdge = await token(appId, userId, { expiresAt: at(-T + SEC) });
    // Access long expired but the refresh token expired only recently → kept.
    const refreshRecent = await token(appId, userId, { expiresAt: at(-T - DAY), refreshExpiresAt: at(-T + SEC) });
    const refreshOld = await token(appId, userId, { expiresAt: at(-T - DAY), refreshExpiresAt: at(-T - SEC) });
    // Revoked more than 30 days ago → gone, even with a live expiry; recently → kept.
    const revokedOld = await token(appId, userId, { expiresAt: at(DAY), revokedAt: at(-T - SEC) });
    const revokedEdge = await token(appId, userId, { expiresAt: at(DAY), revokedAt: at(-T + SEC) });
    // Rotated (and so revoked) long ago, refresh not yet expired → kept for reuse detection.
    const rotatedLive = await token(appId, userId, {
      expiresAt: at(-T),
      refreshExpiresAt: at(SEC),
      revokedAt: at(-T - SEC),
      rotatedAt: at(-T - SEC),
    });
    const rotatedDone = await token(appId, userId, {
      expiresAt: at(-T),
      refreshExpiresAt: at(-SEC),
      revokedAt: at(-T - SEC),
      rotatedAt: at(-T - SEC),
    });
    const live = await token(appId, userId, { expiresAt: at(DAY), refreshExpiresAt: at(30 * DAY) });

    expect(await run()).toEqual({ codes: 1, deviceCodes: 1, tokens: 4 });

    const codes = [codeOld, codeEdge, codeLive];
    expect(
      await remaining(() =>
        env.t.db
          .select({ codeHash: schema.oauthCodes.codeHash })
          .from(schema.oauthCodes)
          .where(inArray(schema.oauthCodes.codeHash, codes)),
      ),
    ).toEqual([codeEdge, codeLive].sort());
    expect(
      await remaining(() =>
        env.t.db
          .select({ id: schema.oauthDeviceCodes.id })
          .from(schema.oauthDeviceCodes)
          .where(inArray(schema.oauthDeviceCodes.id, [devOld, devEdge])),
      ),
    ).toEqual([devEdge]);
    const all = [
      expiredOld,
      expiredEdge,
      refreshRecent,
      refreshOld,
      revokedOld,
      revokedEdge,
      rotatedLive,
      rotatedDone,
      live,
    ];
    expect(
      await remaining(() =>
        env.t.db
          .select({ id: schema.oauthTokens.id })
          .from(schema.oauthTokens)
          .where(inArray(schema.oauthTokens.id, all)),
      ),
    ).toEqual([expiredEdge, refreshRecent, revokedEdge, rotatedLive, live].sort());

    // Idempotent.
    expect(await run()).toEqual({ codes: 0, deviceCodes: 0, tokens: 0 });
  });

  test("deletes in batches until the backlog is gone", async () => {
    const { userId, appId } = await fixtures();
    for (let i = 0; i < 5; i++) await code(appId, userId, at(-2 * DAY));
    for (let i = 0; i < 3; i++) await device(appId, at(-2 * DAY));
    for (let i = 0; i < 4; i++) await token(appId, userId, { expiresAt: at(-40 * DAY) });
    expect(await run(2)).toEqual({ codes: 5, deviceCodes: 3, tokens: 4 });
  });
});
