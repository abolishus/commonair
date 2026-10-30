// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `discord` job (ADR 0028 decision 5): one go-live post, or the studio's test post, to a
 * channel's Discord webhook. A go-live post first claims the per-channel cooldown with one
 * conditional update, so a retried or duplicated job never posts twice within the window; a
 * retryable failure gives the claim back before throwing, so the retry claims again.
 */
import { NOTIFY_JOBS, QUEUES, type DiscordJob } from "@commonair/contracts/internal";
import { NOTIFY_RULES, NOTIFY_SECRET_PURPOSES } from "@commonair/contracts/notify";
import { schema, uuidv7 } from "@commonair/db";
import { decryptSecret } from "@commonair/tokens";
import { eq, sql } from "drizzle-orm";
import type { WorkerContext } from "../../context.ts";
import type { JobMeta } from "../../runtime/registry.ts";
import { goLiveSetting } from "../settings.ts";
import type { DiscordOutcome } from "./outcome.ts";
import { postDiscord, type DiscordTransport } from "./post.ts";
import { goLiveMessage, testMessage, type DiscordMessage } from "./text.ts";

const { discordWebhooks: hooks, channels, broadcasts } = schema;

/** The job definition's backoff: a longer `retry_after` re-enqueues with that delay instead. */
export const DISCORD_BACKOFF_MS = 60_000;
/** Re-enqueues for one post (`-retry-1` … `-retry-3`); after that, BullMQ's own retries only. */
export const MAX_RATE_LIMIT_REENQUEUES = 3;

export type DiscordJobOutcome =
  | DiscordOutcome["kind"]
  /** No webhook for the channel (removed since the job was enqueued). */
  | "none"
  /** A go-live post already went out within the cooldown (including this event's own). */
  | "cooldown"
  /** The channel or broadcast is gone, or the broadcast has ended (a late retry must not say "is live"). */
  | "missing"
  /** The stored URL cannot be decrypted (AUTH_SECRET differs); kept so a fixed config works again. */
  | "undecryptable"
  /** Rate limited with a long wait: a delayed copy of the job was enqueued. */
  | "rescheduled";

export interface DiscordJobResult {
  posted: number;
  outcome: DiscordJobOutcome;
}

/** Thrown for a retryable answer (429 with a short wait, 5xx, network) so BullMQ retries. */
export class DiscordRetry extends Error {
  constructor(readonly outcome: DiscordOutcome["kind"]) {
    super(`discord post failed (${outcome}); will retry`);
    this.name = "DiscordRetry";
  }
}

export type DiscordJobCtx = Pick<WorkerContext, "db" | "logger" | "now" | "enqueue" | "site"> & {
  webhooks: Pick<WorkerContext["webhooks"], "authSecret" | "resolve">;
};

/** The registered handler's transport: the SSRF guard with no exceptions (tests assert this). */
export function productionTransport(ctx: Pick<WorkerContext, "webhooks">): DiscordTransport {
  return { allowInsecure: false, resolve: ctx.webhooks.resolve };
}

/** The id of the delayed copy: the base id (go-live: `discord-<eventId>`) with `-retry-<n>`. */
export function reenqueueId(currentId: string | undefined, data: DiscordJob): { id: string; n: number } {
  const fallback = data.eventId ? `discord-${data.eventId}` : `discord-test-${data.channelId}`;
  const m = /^(.*)-retry-(\d+)$/.exec(currentId ?? "");
  const base = m?.[1] ?? currentId ?? fallback;
  const n = m?.[2] ? Number(m[2]) + 1 : 1;
  return { id: `${base}-retry-${n}`, n };
}

interface Claim {
  at: Date;
  previous: Date | null;
}

const asDate = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string | Date));

/**
 * One statement: take the cooldown when the last post is null or old enough, returning the
 * previous value. The row lock serializes two events of one channel: the second sees the first's
 * committed claim and gets nothing.
 */
async function claimCooldown(ctx: DiscordJobCtx, channelId: string, now: Date): Promise<Claim | null> {
  const { cooldownHours } = await goLiveSetting(ctx.db, ctx.logger, now.getTime());
  const at = now.toISOString();
  const rows = (await ctx.db.execute(sql`
    update discord_webhooks d
       set last_posted_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
      from (select channel_id, last_posted_at as prev from discord_webhooks
             where channel_id = ${channelId}::uuid for update) p
     where d.channel_id = p.channel_id
       and (p.prev is null or p.prev <= ${at}::timestamptz - make_interval(hours => ${cooldownHours}::int))
    returning p.prev`)) as unknown as { prev: string | Date | null }[];
  const [row] = rows;
  return row ? { at: now, previous: asDate(row.prev) } : null;
}

/** `last_posted_at` back to what it was, unless something newer claimed it since. */
const releaseClaim = (claim: Claim | null) =>
  claim
    ? {
        lastPostedAt: sql`case when ${hooks.lastPostedAt} = ${claim.at.toISOString()}::timestamptz
          then ${claim.previous?.toISOString() ?? null}::timestamptz else ${hooks.lastPostedAt} end`,
      }
    : {};

/** Delete the webhook, tell the owner in-app and audit it, in one transaction. */
async function removeWebhook(
  ctx: DiscordJobCtx,
  channelId: string,
  ownerId: string,
  tx: Parameters<Parameters<DiscordJobCtx["db"]["transaction"]>[0]>[0],
): Promise<void> {
  const deleted = await tx.delete(hooks).where(eq(hooks.channelId, channelId)).returning({ id: hooks.channelId });
  if (deleted.length === 0) return;
  await tx.insert(schema.notifications).values({
    userId: ownerId,
    type: "system",
    payload: { kind: "discord_webhook_removed", channelId },
    createdAt: ctx.now(),
  });
  await tx.insert(schema.auditLog).values({
    id: uuidv7(),
    actorType: "system",
    action: "discord_webhook.remove",
    subjectType: "channel",
    subjectId: channelId,
    channelId,
    details: { action: "auto_remove" },
  });
}

/** Builds the message, or undefined when the channel (or the go-live's broadcast) is gone. */
async function buildMessage(
  ctx: DiscordJobCtx,
  data: DiscordJob,
  publicUrl: string,
  instance: string,
): Promise<{ message: DiscordMessage; ownerId: string } | undefined> {
  const [c] = await ctx.db
    .select({ ownerId: channels.ownerId, slug: channels.slug, name: channels.displayName, mature: channels.mature })
    .from(channels)
    .where(eq(channels.id, data.channelId));
  if (!c) return undefined;
  if (data.test) return { message: testMessage({ instance, channel: c.name }), ownerId: c.ownerId };
  if (!data.broadcastId) return undefined;
  const [b] = await ctx.db
    .select({
      title: broadcasts.title,
      mature: broadcasts.mature,
      channelId: broadcasts.channelId,
      endedAt: broadcasts.endedAt,
    })
    .from(broadcasts)
    .where(eq(broadcasts.id, data.broadcastId));
  // A retry (BullMQ backoff or a long 429 re-enqueue) can run hours later: never announce an ended stream.
  if (!b || b.channelId !== data.channelId || b.endedAt !== null) return undefined;
  const url = `${publicUrl.replace(/\/+$/, "")}/${c.slug}`;
  return {
    message: goLiveMessage({ channel: c.name, title: b.title, url, mature: b.mature || c.mature }),
    ownerId: c.ownerId,
  };
}

/**
 * Post one go-live (or test) to the channel's webhook. `transport` is `productionTransport(ctx)`
 * for the registered job; see `DiscordTransport` for what tests change.
 */
export async function runDiscordJob(
  data: DiscordJob,
  ctx: DiscordJobCtx,
  transport: DiscordTransport,
  meta: Pick<JobMeta, "id"> = { id: undefined },
): Promise<DiscordJobResult> {
  const [hook] = await ctx.db.select({ url: hooks.url }).from(hooks).where(eq(hooks.channelId, data.channelId));
  if (!hook) return { posted: 0, outcome: "none" };
  const site = ctx.site;
  if (!site) {
    // main.ts always builds it; a context without it cannot make the channel link.
    ctx.logger.error("discord job has no instance site; not posted", { channelId: data.channelId });
    return { posted: 0, outcome: "missing" };
  }
  const built = await buildMessage(ctx, data, site.publicUrl, site.name);
  if (!built) return { posted: 0, outcome: "missing" };

  let url: string;
  try {
    url = await decryptSecret(ctx.webhooks.authSecret, NOTIFY_SECRET_PURPOSES.discordWebhook, hook.url);
  } catch {
    // Sealed with another AUTH_SECRET: most likely a worker/API secret mismatch or a rotation in
    // progress. Deleting would wipe every channel's webhook on a misconfiguration, so leave the row:
    // a correctly configured run reads it again, and the owner can re-save it.
    ctx.logger.error("discord webhook cannot be decrypted; not posted", { channelId: data.channelId });
    return { posted: 0, outcome: "undecryptable" };
  }

  const now = ctx.now();
  const claim = data.test ? null : await claimCooldown(ctx, data.channelId, now);
  if (!data.test && !claim) return { posted: 0, outcome: "cooldown" };

  const outcome = await postDiscord(url, built.message, transport);
  ctx.logger.info("discord post", { channelId: data.channelId, test: data.test, outcome: outcome.kind });

  switch (outcome.kind) {
    case "posted":
      await ctx.db
        .update(hooks)
        .set({ failures: 0, lastError: null, updatedAt: now })
        .where(eq(hooks.channelId, data.channelId));
      return { posted: 1, outcome: "posted" };

    case "gone":
      await ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .update(hooks)
          .set({
            failures: sql`${hooks.failures} + 1`,
            lastError: outcome.error,
            updatedAt: now,
            ...releaseClaim(claim),
          })
          .where(eq(hooks.channelId, data.channelId))
          .returning({ failures: hooks.failures });
        if (row && row.failures >= NOTIFY_RULES.discordFailureLimit)
          await removeWebhook(ctx, data.channelId, built.ownerId, tx);
      });
      return { posted: 0, outcome: "gone" };

    case "blocked":
      await ctx.db.transaction((tx) => removeWebhook(ctx, data.channelId, built.ownerId, tx));
      return { posted: 0, outcome: "blocked" };

    case "rejected":
      await ctx.db
        .update(hooks)
        .set({ lastError: "rejected", updatedAt: now, ...releaseClaim(claim) })
        .where(eq(hooks.channelId, data.channelId));
      return { posted: 0, outcome: "rejected" };

    case "rate_limited":
    case "network": {
      await ctx.db
        .update(hooks)
        .set({ lastError: outcome.kind, updatedAt: now, ...releaseClaim(claim) })
        .where(eq(hooks.channelId, data.channelId));
      if (
        outcome.kind === "rate_limited" &&
        outcome.retryAfterMs !== null &&
        outcome.retryAfterMs > DISCORD_BACKOFF_MS
      ) {
        const next = reenqueueId(meta.id, data);
        if (next.n <= MAX_RATE_LIMIT_REENQUEUES) {
          await ctx.enqueue(QUEUES.notifications, NOTIFY_JOBS.discord, data, {
            jobId: next.id,
            delayMs: outcome.retryAfterMs,
          });
          return { posted: 0, outcome: "rescheduled" };
        }
      }
      throw new DiscordRetry(outcome.kind);
    }
  }
}
