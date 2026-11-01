// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Signed delivery (ADR 0030 decision 8): one `deliver` job POSTs one activity to one inbox,
 * signed with the channel actor's key, through `postPinned`. A failure schedules the next attempt
 * as a new job on the webhook backoff (`DEFAULT_BACKOFF_MS`); every attempt's outcome updates the
 * inbox's row in `federation_deliveries`, which the sweep reads to drop an inbox failing for
 * `FEDERATION_RULES.dropAfterDays`. Delivery is at least once; activity ids are stable, so remote
 * servers dedupe a repeat.
 *
 * The channel's own setting is checked where activities are made (fan-out, inbox), not here: an
 * actor `Delete` goes out after the setting went off. The instance flag and the block list are
 * re-checked here, since a job may run hours after it was queued.
 */
import { FEDERATION_JOBS, type FederationDeliverJob, federationJobId, QUEUES } from "@commonair/contracts/internal";
import { type Executor, schema as s, uuidv7 } from "@commonair/db";
import { sha256Hex } from "@commonair/tokens";
import { eq, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { nextRetryDelay } from "../webhooks/backoff.ts";
import type { FederationConfig } from "./config.ts";
import { postActivity } from "./http.ts";
import { blockedDomains, isBlocked, loadChannel, signingKey } from "./local.ts";

export type DeliverOutcome =
  /** 2xx. */
  | "delivered"
  /** Failed; the next attempt is queued. */
  | "retrying"
  /** Failed, no attempt left (or a final refusal: the guard, a 4xx other than 408/429). */
  | "failed"
  /** Not sent: the instance flag is off. */
  | "disabled"
  /** Not sent: the inbox's domain is blocked, or the inbox was dropped. */
  | "blocked"
  /** Not sent: no key to sign with (the actor and its retired-key stash are gone). */
  | "no_key";

export interface DeliverResult {
  outcome: DeliverOutcome;
  status?: number;
}

/** Valkey key holding an account-deleted actor's encrypted key until its `Delete` went out. */
export const retiredKeyStashKey = (channelId: string) => `federation:retired-key:${channelId}`;
/** Long enough for every retry of the last `Delete` (the backoff spans about 2.6 h). */
export const RETIRED_KEY_TTL_SECONDS = 24 * 60 * 60;

export interface RetiredKey {
  keyId: string;
  privateKeyEnc: string;
}

/** A deterministic job id per (activity, inbox, attempt): a repeat enqueue is a no-op. */
export async function deliverJobId(activityId: string, inbox: string, attempt: number): Promise<string> {
  const h = (await sha256Hex(`${activityId}\n${inbox}`)).slice(0, 40);
  return federationJobId(FEDERATION_JOBS.deliver, `${h}-${attempt}`);
}

/** Queue one delivery per inbox (attempt 1). */
export async function enqueueDeliveries(
  ctx: Pick<WorkerContext, "enqueueBulk">,
  channelId: string,
  objectId: string | null,
  activity: { id: string },
  inboxes: readonly string[],
): Promise<number> {
  if (inboxes.length === 0) return 0;
  // The activity builders return closed interfaces; the job carries them as a JSON record.
  const json = activity as unknown as Record<string, unknown>;
  const jobs = await Promise.all(
    inboxes.map(async (inbox) => ({
      name: FEDERATION_JOBS.deliver,
      data: { channelId, inbox, objectId, activity: json, attempt: 1 } satisfies FederationDeliverJob,
      opts: { jobId: await deliverJobId(activity.id, inbox, 1) },
    })),
  );
  await ctx.enqueueBulk(QUEUES.federation, jobs);
  return jobs.length;
}

/** Record an attempt's outcome on the inbox's health row. Success clears the failing streak. */
async function recordAttempt(db: Executor, inbox: string, ok: boolean, now: Date): Promise<void> {
  const at = now.toISOString();
  await db
    .insert(s.federationDeliveries)
    .values({
      id: uuidv7(),
      inbox,
      status: ok ? "ok" : "failing",
      firstFailedAt: ok ? null : now,
      lastAttemptAt: now,
    })
    .onConflictDoUpdate({
      target: s.federationDeliveries.inbox,
      set: ok
        ? { status: "ok", firstFailedAt: null, lastAttemptAt: now }
        : {
            status: "failing",
            firstFailedAt: sql`coalesce(${s.federationDeliveries.firstFailedAt}, ${at}::timestamptz)`,
            lastAttemptAt: now,
          },
    });
}

/** Whether a failed answer is worth another attempt. */
const retryable = (status: number | undefined, rejected: boolean) =>
  !rejected && (status === undefined || status === 408 || status === 429 || status >= 500);

export async function runDeliver(
  data: FederationDeliverJob,
  ctx: Pick<WorkerContext, "db" | "valkey" | "logger" | "enqueue" | "now">,
  cfg: FederationConfig,
): Promise<DeliverResult> {
  if (!cfg.enabled) return { outcome: "disabled" };
  const blocks = await blockedDomains(ctx.db);
  if (isBlocked(blocks, data.inbox)) return { outcome: "blocked" };
  const [health] = await ctx.db
    .select({ status: s.federationDeliveries.status })
    .from(s.federationDeliveries)
    .where(eq(s.federationDeliveries.inbox, data.inbox));
  if (health?.status === "dropped") return { outcome: "blocked" };

  let signer: { keyId: string; privateKeyEnc: string } | null = null;
  const ch = await loadChannel(ctx.db, cfg, data.channelId);
  if (ch?.actor) signer = { keyId: ch.actor.keyId, privateKeyEnc: ch.actor.privateKeyEnc };
  else {
    const stash = await ctx.valkey.get(retiredKeyStashKey(data.channelId));
    if (stash) {
      try {
        const k = JSON.parse(stash) as RetiredKey;
        if (typeof k.keyId === "string" && typeof k.privateKeyEnc === "string") signer = k;
      } catch {
        // A corrupt stash cannot sign.
      }
    }
  }
  if (!signer) {
    ctx.logger.warn("federation delivery has no key", { channelId: data.channelId });
    return { outcome: "no_key" };
  }

  const now = ctx.now();
  const privateKey = await signingKey(cfg, signer.privateKeyEnc);
  const res = await postActivity(data.inbox, data.activity, { keyId: signer.keyId, privateKey }, cfg, now);
  const ok = res.ok && res.status >= 200 && res.status < 300;
  await recordAttempt(ctx.db, data.inbox, ok, now);
  const status = res.ok ? res.status : undefined;
  ctx.logger.info("federation delivery", {
    channelId: data.channelId,
    attempt: data.attempt,
    ok,
    ...(status !== undefined ? { status } : {}),
  });
  if (ok) return { outcome: "delivered", status: res.status };

  const delay = retryable(status, !res.ok && res.rejected)
    ? nextRetryDelay(data.attempt, cfg.maxAttempts, cfg.backoffMs)
    : null;
  if (delay === null) return { outcome: "failed", ...(status !== undefined ? { status } : {}) };
  const activityId = typeof data.activity.id === "string" ? data.activity.id : JSON.stringify(data.activity);
  await ctx.enqueue(
    QUEUES.federation,
    FEDERATION_JOBS.deliver,
    { ...data, attempt: data.attempt + 1 } satisfies FederationDeliverJob,
    { jobId: await deliverJobId(activityId, data.inbox, data.attempt + 1), delayMs: delay },
  );
  return { outcome: "retrying", ...(status !== undefined ? { status } : {}) };
}
