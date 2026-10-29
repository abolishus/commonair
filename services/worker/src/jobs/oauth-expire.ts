// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hourly OAuth housekeeping (ADR 0027, E9-oauth): authorization and device codes a day past
 * their expiry, and tokens long dead. Deletes run in batches so a backlog never holds a long lock.
 */
import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { defineJob } from "../runtime/registry.ts";

const DAY_MS = 86_400_000;
export const OAUTH_EXPIRE_BATCH = 5000;
/** Codes are kept a day past expiry (support questions about a failed sign-in). */
export const CODE_GRACE_MS = DAY_MS;
/** Dead tokens are kept 30 days (the "authorized apps" history a user may ask about). */
export const TOKEN_GRACE_MS = 30 * DAY_MS;

async function drain(run: () => Promise<number>, batch: number): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await run();
    total += n;
    if (n < batch) return total;
  }
}

export async function expireOAuth(
  ctx: Pick<WorkerContext, "sql" | "now">,
  batch = OAUTH_EXPIRE_BATCH,
): Promise<{ codes: number; deviceCodes: number; tokens: number }> {
  const now = ctx.now();
  const codeCutoff = new Date(now.getTime() - CODE_GRACE_MS).toISOString();
  const tokenCutoff = new Date(now.getTime() - TOKEN_GRACE_MS).toISOString();
  const nowIso = now.toISOString();

  const codes = await drain(
    async () =>
      (
        await ctx.sql`
          delete from oauth_codes where code_hash in (
            select code_hash from oauth_codes where expires_at < ${codeCutoff}::timestamptz limit ${batch})`
      ).count,
    batch,
  );
  const deviceCodes = await drain(
    async () =>
      (
        await ctx.sql`
          delete from oauth_device_codes where id in (
            select id from oauth_device_codes where expires_at < ${codeCutoff}::timestamptz limit ${batch})`
      ).count,
    batch,
  );
  // Rotated rows stay until their refresh token expires, so presenting it again is still caught
  // as reuse (and revokes the family) rather than looking unknown.
  const tokens = await drain(
    async () =>
      (
        await ctx.sql`
          delete from oauth_tokens where id in (
            select id from oauth_tokens
             where (
                     expires_at < ${tokenCutoff}::timestamptz
                     and (refresh_expires_at is null or refresh_expires_at < ${tokenCutoff}::timestamptz)
                   )
                or (
                     revoked_at < ${tokenCutoff}::timestamptz
                     and (rotated_at is null or refresh_expires_at < ${nowIso}::timestamptz)
                   )
             limit ${batch})`
      ).count,
    batch,
  );
  return { codes, deviceCodes, tokens };
}

export const job = defineJob({
  queue: QUEUES.retention,
  name: "oauth-expire",
  description: "Delete expired authorization and device codes and long-dead OAuth tokens (ADR 0027)",
  data: z.object({}),
  schedule: { pattern: "17 * * * *" },
  handler: async (_data, ctx) => expireOAuth(ctx),
});
