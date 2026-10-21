// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Persistence, shutdown, heartbeats, backpressure and the Valkey limiter. */
import { connect as tcpConnect, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { inArray } from "drizzle-orm";
import { BUS, CHAT_LIMITS } from "@commonair/contracts";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey } from "@commonair/service";
import { ValkeyLimiter } from "../src/limiter.ts";
import { createMetrics } from "../src/metrics.ts";
import { MessageWriter } from "../src/persistence.ts";
import {
  chatToken,
  Client,
  createChannel,
  createUser,
  eventually,
  isolation,
  quietLogger,
  startInstance,
  VALKEY_URL,
} from "./helpers.ts";

// Suites run in parallel with every other workspace: generous deadlines for tests, and for teardown,
// since Postgres runs DROP DATABASE one at a time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

describe("persistence", () => {
  test("buffered messages are flushed on shutdown", async () => {
    const svc = await startInstance(t.db, isolation(), { writer: { intervalMs: 60_000, batchSize: 10_000 } });
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const c = await Client.connect(svc, { token: await chatToken(owner.id) });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await c.say(ch.slug, `msg ${i}`)).ack.id ?? "");
    expect(await t.db.select().from(schema.chatMessages).where(inArray(schema.chatMessages.id, ids))).toHaveLength(0);
    await svc.stop();
    const rows = await t.db.select().from(schema.chatMessages).where(inArray(schema.chatMessages.id, ids));
    expect(rows.map((r) => r.body).sort()).toEqual(["msg 0", "msg 1", "msg 2", "msg 3", "msg 4"]);
    // Clients were told to reconnect elsewhere.
    await eventually(() => c.closed);
    expect(c.closed?.code).toBe(1012);
  });

  test("a full batch flushes without waiting for the interval", async () => {
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const writer = new MessageWriter(t.db, quietLogger, createMetrics(), { intervalMs: 60_000, batchSize: 3 });
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    for (const id of ids) writer.enqueue({ id, channelId: ch.id, userId: owner.id, body: "b" });
    await eventually(
      async () =>
        (await t.db.select().from(schema.chatMessages).where(inArray(schema.chatMessages.id, ids))).length === 3,
    );
    expect(writer.pending).toBe(0);
    await writer.close();
  });

  test("one bad row does not sink its batch", async () => {
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const writer = new MessageWriter(t.db, quietLogger, createMetrics(), { intervalMs: 60_000 });
    const good = [uuidv7(), uuidv7()];
    writer.enqueue({ id: good[0], channelId: ch.id, userId: owner.id, body: "ok 1" });
    writer.enqueue({ id: uuidv7(), channelId: ch.id, userId: crypto.randomUUID(), body: "orphan" }); // FK violation
    writer.enqueue({ id: good[1], channelId: ch.id, userId: owner.id, body: "ok 2" });
    await writer.close();
    expect(
      await t.db
        .select()
        .from(schema.chatMessages)
        .where(inArray(schema.chatMessages.id, good as string[])),
    ).toHaveLength(2);
    expect(writer.pending).toBe(0);
  });
});

describe("heartbeats", () => {
  test("sockets that stop pinging are closed after two intervals", async () => {
    const svc = await startInstance(t.db, isolation(), { heartbeatMs: 300 });
    try {
      const pinger = await Client.connect(svc);
      const idle = await Client.connect(svc);
      expect(idle.frames[0]).toMatchObject({ op: "welcome", heartbeatMs: 300 });
      const timer = setInterval(() => pinger.send({ op: "ping" }), 150);
      await eventually(() => idle.closed, 3000);
      clearInterval(timer);
      expect(idle.closed?.code).toBe(4000);
      expect(pinger.closed).toBeNull();
      pinger.close();
    } finally {
      await svc.stop();
    }
  });
});

/** A raw WebSocket client that joins a room and then stops reading from its socket. */
async function stalledClient(port: number, channel: string): Promise<Socket> {
  const sock = tcpConnect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  sock.write(
    [
      "GET /ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${btoa("stalledclient-01")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  const payload = Buffer.from(JSON.stringify({ op: "join", channel }));
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] ?? 0)));
  sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
  let seen = "";
  await new Promise<void>((resolve) => {
    const onData = (d: Buffer) => {
      seen += d.toString("latin1");
      if (seen.includes('"op":"joined"')) {
        sock.off("data", onData);
        resolve();
      }
    };
    sock.on("data", onData);
  });
  sock.pause();
  return sock;
}

describe("backpressure", () => {
  test("a client that stops reading is terminated instead of buffered without bound", async () => {
    const iso = isolation();
    const svc = await startInstance(t.db, iso, { maxBufferedBytes: 64 * 1024 });
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const healthy = await Client.connect(svc);
    await healthy.join(ch.slug);
    const stalled = await stalledClient(Number(svc.url.port), ch.slug);
    expect(svc.connections()).toBe(2);
    const pub = createValkey(VALKEY_URL);
    try {
      const filler = "x".repeat(8 * 1024);
      const event = (i: number) =>
        JSON.stringify({
          id: crypto.randomUUID(),
          type: "channel.tip",
          version: "1",
          channelId: ch.id,
          payload: { i, message: filler },
          occurredAt: new Date().toISOString(),
        });
      for (let i = 0; i < 4000 && svc.connections() > 1; i++) {
        await pub.publish(iso.busPrefix + BUS.events, event(i));
        if (i % 100 === 0) await Bun.sleep(5);
      }
      await eventually(() => svc.connections() === 1, 5000);
      // The healthy reader is unaffected.
      expect(healthy.closed).toBeNull();
      expect(healthy.frames.some((f) => f.op === "event")).toBe(true);
    } finally {
      stalled.destroy();
      healthy.close();
      await pub.quit();
      await svc.stop();
    }
  });
});

describe("ValkeyLimiter", () => {
  const valkey = createValkey(VALKEY_URL, { keyPrefix: `test:${crypto.randomUUID()}:` });
  afterAll(() => valkey.quit());
  const limiter = new ValkeyLimiter(valkey);

  test("sliding window shared through Valkey", async () => {
    const c = crypto.randomUUID();
    const now = Date.now();
    const results = [];
    for (let i = 0; i < CHAT_LIMITS.user + 2; i++) results.push(await limiter.hit(c, "u", CHAT_LIMITS.user, 1000, now));
    expect(results.filter(Boolean)).toHaveLength(CHAT_LIMITS.user);
    expect(await limiter.hit(c, "other", CHAT_LIMITS.user, 1000, now)).toBe(true);
    expect(await limiter.hit(c, "u", CHAT_LIMITS.user, 1000, now + 1001)).toBe(true);
  });

  test("slow mode is reserved atomically across concurrent senders", async () => {
    const c = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.reserveSlow(c, "u", 2)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const denied = results.find((r) => !r.ok);
    expect(denied && !denied.ok && denied.waitMs).toBeGreaterThan(1000);
    const winner = results.find((r) => r.ok);
    if (winner?.ok) await winner.reservation.release();
    expect((await limiter.reserveSlow(c, "u", 2)).ok).toBe(true);
  });

  test("duplicates are reserved per exact body with a TTL", async () => {
    const c = crypto.randomUUID();
    const claims = await Promise.all(Array.from({ length: 10 }, () => limiter.reserveDuplicate(c, "u", "hello", 500)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await limiter.reserveDuplicate(c, "u", "hello!", 500)).not.toBeNull();
    expect(await limiter.reserveDuplicate(c, "v", "hello", 500)).not.toBeNull();
    await Bun.sleep(600);
    expect(await limiter.reserveDuplicate(c, "u", "hello", 500)).not.toBeNull();
  });
});
