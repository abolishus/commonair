// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A WebSocket upgrade whose profile read cannot finish (the users table is locked, as a stalled
 * Postgres connection would leave it) is answered 503 within the deadline instead of hanging,
 * and upgrades succeed again once the database answers.
 */
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { Directory } from "../src/directory.ts";
import type { ChatService } from "../src/server.ts";
import { chatToken, Client, createUser, isolation, startInstance } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let svc: ChatService;

beforeAll(async () => {
  t = await createTestDatabase();
  svc = await startInstance(t.app.db, isolation(), { upgradeTimeoutMs: 500, filterWorkers: 0 });
});
afterAll(async () => {
  await svc?.stop();
  await t?.drop();
});

/** A raw upgrade request, so the HTTP status of a refused upgrade is visible. */
async function upgradeStatus(token: string): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  const url = new URL(svc.wsUrl);
  url.protocol = "http:";
  url.searchParams.set("token", token);
  const res = await fetch(url, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": btoa("0123456789abcdef"),
    },
    signal: AbortSignal.timeout(5_000),
  });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
}

test("a stalled profile read answers 503 within the deadline, then upgrades recover", async () => {
  const user = await createUser(t.db);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let locked: () => void = () => {};
  const isLocked = new Promise<void>((r) => {
    locked = r;
  });
  const tx = t.sql.begin(async (sql) => {
    await sql`lock table users in access exclusive mode`;
    locked();
    await held;
  });
  try {
    await isLocked;
    const started = performance.now();
    const r = await upgradeStatus(await chatToken(user.id));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "unavailable" });
    expect(r.retryAfter).toBe("1");
    expect(performance.now() - started).toBeLessThan(3_000);
  } finally {
    release();
    await tx;
  }
  const client = await Client.connect(svc, { token: await chatToken(user.id) });
  try {
    const welcome = client.frames.find((f) => f.op === "welcome");
    expect(welcome && "user" in welcome ? welcome.user?.id : null).toBe(user.id);
  } finally {
    client.close();
  }
});

test("the profile read (one statement) reports active membership only", async () => {
  const directory = new Directory(t.app.db);
  const none = await createUser(t.db);
  const active = await createUser(t.db);
  const lapsed = await createUser(t.db);
  await t.db.insert(schema.memberships).values([
    { id: uuidv7(), userId: active.id, class: "viewer", basis: "share" },
    { id: uuidv7(), userId: lapsed.id, class: "viewer", basis: "share", status: "lapsed" },
  ]);
  expect((await directory.profile(none.id))?.isMember).toBe(false);
  expect((await directory.profile(active.id))?.isMember).toBe(true);
  expect((await directory.profile(lapsed.id))?.isMember).toBe(false);
  expect(await directory.profile(uuidv7())).toBeNull();
  expect(await directory.profile(active.id)).toMatchObject({
    id: active.id,
    username: active.username,
    deleted: false,
  });
});
