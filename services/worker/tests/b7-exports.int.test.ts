// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 export seams (contract step §5.1): a `bundle` export is dispatched to `exports/bundle.ts`
 * (a stub that throws until W3-portability lands) inside the shared pipeline, and needs a channel.
 */
import { schema, uuidv7 } from "@commonair/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { buildExport } from "../src/exports/build.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
let ctx: WorkerContext;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
  // Never reached by the bundle path: the stub throws before anything is uploaded.
  ctx = { ...env.worker.ctx, storage: {} as never };
});
afterAll(async () => {
  await env.close();
});

async function bundleExport(userId: string) {
  const id = uuidv7();
  await env.t.db.insert(schema.dataExports).values({ id, userId, kind: "bundle" });
  return id;
}
const status = async (id: string) =>
  (await env.t.db.select().from(schema.dataExports).where(eq(schema.dataExports.id, id)))[0];

test("a bundle export reaches buildBundle; the shared pipeline retries, then fails it", async () => {
  const { user } = await makeUser(env.t.db);
  const id = await bundleExport(user.id);
  await expect(buildExport(ctx, id, { lastAttempt: false })).rejects.toThrow(/bundle export is not implemented/);
  expect(await status(id)).toMatchObject({ status: "queued" });
  expect(await buildExport(ctx, id, { lastAttempt: true })).toEqual({ failed: 1 });
  expect(await status(id)).toMatchObject({ status: "failed", error: "build_failed", storageKey: null });
});

test("a bundle export without a channel fails at once", async () => {
  const { user } = await makeUser(env.t.db);
  await env.t.db.delete(schema.channels).where(eq(schema.channels.ownerId, user.id));
  const id = await bundleExport(user.id);
  expect(await buildExport(ctx, id, { lastAttempt: false })).toEqual({ failed: 1 });
  expect(await status(id)).toMatchObject({ status: "failed", error: "no_channel" });
});
