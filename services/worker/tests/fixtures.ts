// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Shared helpers for the integration tests (not a test file itself). */
import { verifyWebhook, WEBHOOK_HEADERS } from "@commonair/contracts/events";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import { encryptSecret, randomSecret, sha256Hex } from "@commonair/tokens";
import { vi } from "vite-plus/test";
import { createWorker, type CreateWorkerOptions, type WorkerHandle } from "../src/worker.ts";
import type { WebhookSettings } from "../src/webhooks/settings.ts";

export const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
export const AUTH_SECRET = "test-auth-secret-0123456789-abcdefghijklmnop";
// Integration suites share the machine with other heavy suites: generous per-test deadlines,
// and every wait polls for its condition instead of sleeping a fixed time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

export const quietLogger = createLogger({ service: "worker-test", level: "fatal" });

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  { timeoutMs = 15_000, intervalMs = 25, label = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(intervalMs);
  }
}

export function fastWebhooks(over: Partial<WebhookSettings> = {}): WebhookSettings {
  return {
    authSecret: AUTH_SECRET,
    allowInsecure: true,
    timeoutMs: 2_000,
    maxResponseBytes: 64 * 1024,
    logBodyBytes: 2048,
    backoffMs: [40, 40, 40, 40],
    maxAttempts: 5,
    failureThreshold: 3,
    ...over,
  };
}

export interface TestEnv {
  t: TestDatabase;
  worker: WorkerHandle;
  tag: string;
  close(): Promise<void>;
}

/** A throwaway database plus a worker isolated by key prefix, BullMQ prefix and bus channel. */
export async function setup(over: Partial<CreateWorkerOptions> = {}): Promise<TestEnv> {
  const t = await createTestDatabase();
  const tag = crypto.randomUUID();
  const worker = createWorker({
    db: t,
    valkeyUrl: VALKEY_URL,
    logger: quietLogger,
    webhooks: fastWebhooks(),
    keyPrefix: `test:${tag}:`,
    bullPrefix: `test-bull-${tag}`,
    busChannel: `test:${tag}:bus:events`,
    segmentStream: `test:${tag}:stream:segments`,
    ...over,
  });
  return {
    t,
    worker,
    tag,
    async close() {
      await worker.stop(2_000);
      await t.drop();
    },
  };
}

export async function makeUser(db: Database, name = `u${Math.random().toString(36).slice(2, 10)}`) {
  const [user] = await db
    .insert(schema.users)
    .values({ id: uuidv7(), name, email: `${name}@example.test`, username: name })
    .returning();
  const [channel] = await db
    .insert(schema.channels)
    .values({ id: uuidv7(), ownerId: user!.id, slug: name, displayName: name })
    .returning();
  return { user: user!, channel: channel! };
}

export async function makeBroadcast(db: Database, channelId: string, startedAt = new Date()) {
  const [b] = await db
    .insert(schema.broadcasts)
    .values({ id: uuidv7(), channelId, ingestProtocol: "rtmp", path: `live/${channelId}`, startedAt })
    .returning();
  return b!;
}

export async function makeApp(db: Database, ownerId: string) {
  const [app] = await db
    .insert(schema.oauthApps)
    .values({
      id: uuidv7(),
      ownerId,
      name: "test app",
      clientId: randomSecret("cid_", 8),
      clientSecretHash: await sha256Hex("x"),
      redirectUris: ["https://app.example.test/cb"],
    })
    .returning();
  return app!;
}

export async function makeToken(db: Database, appId: string, userId: string, scopes: string[]) {
  const [tok] = await db
    .insert(schema.oauthTokens)
    .values({
      id: uuidv7(),
      appId,
      userId,
      scopes,
      accessTokenHash: await sha256Hex(randomSecret()),
      refreshTokenHash: await sha256Hex(randomSecret()),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  return tok!;
}

export async function makeSubscription(
  db: Database,
  input: {
    userId: string;
    appId?: string | null;
    type: string;
    condition: Record<string, string>;
    callbackUrl: string;
    secret: string;
    status?: "enabled" | "verification_pending" | "failed" | "revoked";
  },
) {
  const [sub] = await db
    .insert(schema.eventSubscriptions)
    .values({
      id: uuidv7(),
      userId: input.userId,
      appId: input.appId ?? null,
      type: input.type,
      condition: input.condition,
      transport: "webhook",
      callbackUrl: input.callbackUrl,
      secretCiphertext: await encryptSecret(AUTH_SECRET, "webhook", input.secret),
      status: input.status ?? "enabled",
    })
    .returning();
  return sub!;
}

export const broadcasterFields = (u: { id: string; username: string; name: string }) => ({
  broadcaster_user_id: u.id,
  broadcaster_user_login: u.username,
  broadcaster_user_name: u.name,
});

export async function insertEvent(
  db: Database,
  type: string,
  channelId: string | null,
  payload: Record<string, unknown>,
) {
  const [e] = await db.insert(schema.events).values({ id: uuidv7(), type, channelId, payload }).returning();
  return e!;
}

export interface Received {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  raw: string;
  signatureValid: boolean;
}

/**
 * A local webhook receiver that verifies every signature with the secret it is
 * given and answers per path through `respond`.
 */
export function startReceiver(secret: string, respond: (path: string, body: Record<string, unknown>) => Response) {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text();
      const headers = Object.fromEntries(req.headers.entries());
      const signatureValid = await verifyWebhook(
        secret,
        headers[WEBHOOK_HEADERS.messageId] ?? "",
        headers[WEBHOOK_HEADERS.messageTimestamp] ?? "",
        raw,
        headers[WEBHOOK_HEADERS.messageSignature] ?? "",
      );
      const body = JSON.parse(raw) as Record<string, unknown>;
      const path = new URL(req.url).pathname;
      received.push({ path, headers, body, raw, signatureValid });
      return respond(path, body);
    },
  });
  return {
    url: (path: string) => `http://127.0.0.1:${server.port}${path}`,
    received,
    on: (path: string) => received.filter((r) => r.path === path),
    stop: () => server.stop(true),
  };
}
