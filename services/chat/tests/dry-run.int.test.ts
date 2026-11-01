// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The chat dry run (rehearsal's simulated chat): the real pipeline, nothing stored or broadcast. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, type ChatDryRunResult } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { syntheticSenderId } from "../src/dry-run.ts";
import type { ChatService } from "../src/server.ts";
import { chatToken, Client, createChannel, createUser, isolation, SECRET, startInstance } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let svc: ChatService;
const iso = isolation();
const clients: Client[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  svc = await startInstance(t.db, iso, { writer: { intervalMs: 20 } });
});
afterAll(async () => {
  for (const c of clients) c.close();
  await svc?.stop();
  await t?.drop();
});

const dryRun = (body: unknown, secret = SECRET) =>
  fetch(new URL(INTERNAL_ROUTES.chatDryRun, svc.url), {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
  });
const send = async (channelId: string, body: string, senderKey = "s1") => {
  const res = await dryRun({ channelId, senderKey, body });
  expect(res.status).toBe(200);
  return (await res.json()) as ChatDryRunResult;
};

describe("chat dry run", () => {
  test("accepted, held and rejected follow the channel's real rules", async () => {
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner, { linksAllowed: false, followersOnlyMinutes: 10 });
    await t.db.insert(schema.wordFilters).values([
      { channelId: ch.id, pattern: "suspicious", action: "hold" },
      { channelId: ch.id, pattern: "forbidden", action: "block" },
    ]);
    expect(await send(ch.id, "hello rehearsal")).toEqual({ outcome: "accepted", code: null });
    expect(await send(ch.id, "this is suspicious")).toEqual({ outcome: "held", code: null });
    expect(await send(ch.id, "a forbidden word")).toEqual({ outcome: "rejected", code: "msg_rejected" });
    expect(await send(ch.id, "see https://example.test/x")).toEqual({
      outcome: "rejected",
      code: "msg_links_blocked",
    });
    // Duplicates apply per synthetic sender, as for a person; another sender may say the same.
    expect(await send(ch.id, "hello rehearsal")).toEqual({ outcome: "rejected", code: "msg_duplicate" });
    expect(await send(ch.id, "hello rehearsal", "s2")).toEqual({ outcome: "accepted", code: null });
  });

  test("never saved, never broadcast to the channel's chat", async () => {
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const watcher = await Client.connect(svc, { token: await chatToken(owner.id) });
    clients.push(watcher);
    await watcher.join(ch.slug);
    expect(await send(ch.id, "simulated hello")).toEqual({ outcome: "accepted", code: null });
    expect(await watcher.never((f) => f.op === "message", 500)).toBe(true);
    await svc.flush();
    const rows = await t.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.channelId, ch.id));
    expect(rows).toEqual([]);
  });

  test("refuses a wrong secret, a bad body, another method and an unknown channel", async () => {
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    expect((await dryRun({ channelId: ch.id, senderKey: "s", body: "x" }, "wrong")).status).toBe(401);
    expect((await dryRun({ channelId: ch.id, senderKey: "", body: "x" })).status).toBe(400);
    expect((await dryRun({ channelId: "not-a-uuid", senderKey: "s", body: "x" })).status).toBe(400);
    expect((await fetch(new URL(INTERNAL_ROUTES.chatDryRun, svc.url))).status).toBe(405);
    const unknown = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";
    expect((await dryRun({ channelId: unknown, senderKey: "s", body: "x" })).status).toBe(404);
  });

  test("the synthetic sender id is stable per channel and sender, and never collides across them", async () => {
    const a = "0192f3a4-5b6c-7d8e-9f01-0000000000a1";
    const b = "0192f3a4-5b6c-7d8e-9f01-0000000000b1";
    expect(await syntheticSenderId(a, "x")).toBe(await syntheticSenderId(a, "x"));
    expect(await syntheticSenderId(a, "x")).not.toBe(await syntheticSenderId(a, "y"));
    expect(await syntheticSenderId(a, "x")).not.toBe(await syntheticSenderId(b, "x"));
    expect(await syntheticSenderId(a, "x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
