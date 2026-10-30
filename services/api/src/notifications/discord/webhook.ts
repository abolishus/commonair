// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A channel's Discord webhook (ADR 0028 decision 5). The URL is a secret: it is sealed on the way
 * in and never read back here. The status says whether one is set and how the last post went.
 */
import type { DiscordWebhookStatus } from "@commonair/contracts/dto";
import { NOTIFY_SECRET_PURPOSES } from "@commonair/contracts/notify";
import { schema, type Database, type Executor } from "@commonair/db";
import { encryptSecret } from "@commonair/tokens";
import { eq } from "drizzle-orm";

const { discordWebhooks: hooks } = schema;

/** What `discord_webhooks` holds for a channel, as the studio sees it. */
export function toStatus(
  row: Pick<typeof hooks.$inferSelect, "setAt" | "lastPostedAt" | "lastError"> | undefined,
): DiscordWebhookStatus {
  if (!row) return { configured: false, setAt: null, lastPostedAt: null, lastError: null };
  return {
    configured: true,
    setAt: row.setAt.toISOString(),
    lastPostedAt: row.lastPostedAt?.toISOString() ?? null,
    lastError: row.lastError ?? null,
  };
}

export async function webhookStatus(db: Pick<Database, "select">, channelId: string): Promise<DiscordWebhookStatus> {
  const [row] = await db
    .select({ setAt: hooks.setAt, lastPostedAt: hooks.lastPostedAt, lastError: hooks.lastError })
    .from(hooks)
    .where(eq(hooks.channelId, channelId));
  return toStatus(row);
}

export const sealWebhookUrl = (authSecret: string, url: string): Promise<string> =>
  encryptSecret(authSecret, NOTIFY_SECRET_PURPOSES.discordWebhook, url);

/**
 * Set (or replace) the webhook. A new URL starts clean: no failures, no error. `last_posted_at`
 * stays, so replacing the URL does not reopen the go-live cooldown.
 */
export async function upsertWebhook(
  tx: Executor,
  w: { channelId: string; sealedUrl: string; setBy: string; now: Date },
): Promise<DiscordWebhookStatus> {
  const [row] = await tx
    .insert(hooks)
    .values({ channelId: w.channelId, url: w.sealedUrl, setBy: w.setBy, setAt: w.now, updatedAt: w.now })
    .onConflictDoUpdate({
      target: hooks.channelId,
      set: { url: w.sealedUrl, setBy: w.setBy, setAt: w.now, failures: 0, lastError: null, updatedAt: w.now },
    })
    .returning({ setAt: hooks.setAt, lastPostedAt: hooks.lastPostedAt, lastError: hooks.lastError });
  return toStatus(row);
}

/** True when a webhook was there to delete. */
export async function deleteWebhook(tx: Executor, channelId: string): Promise<boolean> {
  const deleted = await tx.delete(hooks).where(eq(hooks.channelId, channelId)).returning({ id: hooks.channelId });
  return deleted.length > 0;
}

/** The `test` dedupe window: whole minutes since the epoch. */
export const testMinute = (now: Date): number => Math.floor(now.getTime() / 60_000);
