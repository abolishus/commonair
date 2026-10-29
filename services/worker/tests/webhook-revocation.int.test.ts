// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `webhook-revocation`: the API revoked a webhook subscription; the receiver hears about it once. */
import { WEBHOOK_HEADERS } from "@commonair/contracts/events";
import { schema } from "@commonair/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { job } from "../src/jobs/webhook-revocation.ts";
import { makeSubscription, makeUser, setup, startReceiver, type TestEnv } from "./fixtures.ts";

const SECRET = "receiver-secret-0123";
let env: TestEnv;
const receiver = startReceiver(SECRET, () => new Response("ok"));
const meta = { id: undefined, attemptsMade: 0 };

beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await receiver.stop();
  await env.close();
});

const run = (subscriptionId: string) => job.handler({ subscriptionId }, env.worker.ctx, meta);
const logOf = (subscriptionId: string) =>
  env.t.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.subscriptionId, subscriptionId));

describe("webhook-revocation", () => {
  test("a revoked subscription gets one signed revocation POST and one log row; retries send nothing", async () => {
    const { user } = await makeUser(env.t.db);
    const sub = await makeSubscription(env.t.db, {
      userId: user.id,
      type: "channel.follow",
      condition: { broadcaster_user_id: user.id },
      callbackUrl: receiver.url("/revoked"),
      secret: SECRET,
      status: "revoked",
    });
    expect(await run(sub.id)).toEqual({ sent: 1 });
    const hits = receiver.on("/revoked");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.signatureValid).toBe(true);
    expect(hits[0]?.headers[WEBHOOK_HEADERS.messageType]).toBe("revocation");
    expect(hits[0]?.body.subscription).toMatchObject({ id: sub.id, status: "authorization_revoked" });
    const rows = await logOf(sub.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageType: "revocation", status: "succeeded" });

    // A BullMQ retry, or a second enqueue for the same subscription.
    expect(await run(sub.id)).toEqual({ sent: 0 });
    expect(receiver.on("/revoked")).toHaveLength(1);
    expect(await logOf(sub.id)).toHaveLength(1);
  });

  test("an enabled subscription is skipped", async () => {
    const { user } = await makeUser(env.t.db);
    const sub = await makeSubscription(env.t.db, {
      userId: user.id,
      type: "channel.follow",
      condition: { broadcaster_user_id: user.id },
      callbackUrl: receiver.url("/enabled"),
      secret: SECRET,
    });
    expect(await run(sub.id)).toEqual({ sent: 0 });
    expect(receiver.on("/enabled")).toHaveLength(0);
    expect(await logOf(sub.id)).toHaveLength(0);
  });

  test("a missing subscription is skipped", async () => {
    expect(await run("01900000-0000-7000-8000-000000000000")).toEqual({ sent: 0 });
  });

  test("a revoked WebSocket subscription is skipped (no callback)", async () => {
    const { user } = await makeUser(env.t.db);
    const [sub] = await env.t.db
      .insert(schema.eventSubscriptions)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        type: "channel.follow",
        condition: { broadcaster_user_id: user.id },
        transport: "websocket",
        websocketSessionId: "session-1",
        status: "revoked",
      })
      .returning();
    expect(await run(sub!.id)).toEqual({ sent: 0 });
  });
});
