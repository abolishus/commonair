// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E6 schema (0022, ADR 0021): one active overlay token per channel, and the new indexes. */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import type { Database } from "../src/client.ts";

let t: TestDatabase;
let app: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

async function makeChannel(name: string): Promise<string> {
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  const [c] = await app
    .insert(s.channels)
    .values({ ownerId: u!.id, slug: name, displayName: name })
    .returning({ id: s.channels.id });
  return c!.id;
}

describe("overlay tokens", () => {
  test("a channel has at most one unrevoked token; revoking frees the slot", async () => {
    const channelId = await makeChannel("overlay1");
    const [first] = await app
      .insert(s.overlayTokens)
      .values({ channelId, tokenHash: "h1", expiresAt: null })
      .returning({ id: s.overlayTokens.id });
    await expect(app.insert(s.overlayTokens).values({ channelId, tokenHash: "h2" })).rejects.toThrow(/insert/);
    await app.update(s.overlayTokens).set({ revokedAt: new Date() }).where(eq(s.overlayTokens.id, first!.id));
    await app
      .insert(s.overlayTokens)
      .values({ channelId, tokenHash: "h2", expiresAt: new Date(Date.now() + 86_400_000) });
    const rows = await app.select().from(s.overlayTokens).where(eq(s.overlayTokens.channelId, channelId));
    expect(rows).toHaveLength(2);
  });

  test("tokens of different channels do not collide", async () => {
    const a = await makeChannel("overlay2");
    const b = await makeChannel("overlay3");
    await app.insert(s.overlayTokens).values({ channelId: a, tokenHash: "ha" });
    await app.insert(s.overlayTokens).values({ channelId: b, tokenHash: "hb" });
    const rows = await app.select({ id: s.overlayTokens.id }).from(s.overlayTokens);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("indexes", () => {
  test("vods.broadcast_id and the export expiry index exist", async () => {
    const rows = await t.db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where indexname in ('vods_broadcast_idx', 'data_exports_expiry_idx', 'overlay_tokens_active_uq')`,
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      "data_exports_expiry_idx",
      "overlay_tokens_active_uq",
      "vods_broadcast_idx",
    ]);
  });
});
