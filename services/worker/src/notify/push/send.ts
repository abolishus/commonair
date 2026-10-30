// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One web push to one browser (RFC 8030, ADR 0028 decisions 1 and 6): decrypt the stored
 * subscription, encrypt the payload to it, POST through the pinned SSRF guard, and keep the row
 * honest from the push service's answer. Endpoints and keys are never logged: logs carry the row id.
 */
import { NOTIFY_RULES, NOTIFY_SECRET_PURPOSES, type PushPayload } from "@commonair/contracts/notify";
import { schema } from "@commonair/db";
import { b64url, decryptSecret, fromB64url } from "@commonair/tokens";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { WorkerContext } from "../../context.ts";
import { postPinned, type PostResult } from "../../webhooks/http.ts";
import type { WebPushSettings } from "../settings.ts";
import { encryptPushPayload, PushKeyInvalid } from "./ece.ts";
import { vapidAuthorization } from "./vapid.ts";

const { pushSubscriptions } = schema;

/** Consecutive 400/401/403 answers after which a subscription is deleted (made for another VAPID key, it never works). */
export const PUSH_FAILURE_LIMIT = 5;
export const PUSH_TIMEOUT_MS = 10_000;
export const PUSH_MAX_RESPONSE_BYTES = 4096;
export const PUSH_USER_AGENT = "CommonAir-Push/1";

/** What `push_subscriptions.subscription` decrypts to. */
const StoredSubscription = z.object({ endpoint: z.string(), p256dh: z.string(), auth: z.string() });
export type StoredSubscription = z.infer<typeof StoredSubscription>;

/**
 * - `sent`: the push service accepted it.
 * - `removed`: the row was deleted (expired, refused for good, or unsendable).
 * - `retry`: worth trying again (429, 5xx, network, DNS).
 * - `failed`: not sent, not retried (413, a 4xx below the failure limit, a row this worker cannot
 *   decrypt, or a payload it cannot encrypt).
 */
export type PushOutcome = "sent" | "removed" | "retry" | "failed";

/** What to do with an answer, before touching the database. Pure. */
export type PushVerdict = "success" | "expired" | "too_large" | "retry" | "refused" | "unsendable";

// resolveCallback's own words for a lookup that may work next time; every other rejection is final.
const TRANSIENT_REJECTIONS = new Set(["host does not resolve", "callback resolution failed"]);

export function classifyPushResult(result: PostResult): PushVerdict {
  if (!result.ok) return result.rejected && !TRANSIENT_REJECTIONS.has(result.error) ? "unsendable" : "retry";
  const s = result.status;
  if (s >= 200 && s < 300) return "success";
  if (s === 404 || s === 410) return "expired";
  if (s === 413) return "too_large";
  if (s === 429 || s >= 500) return "retry";
  return "refused";
}

/** RFC 8030 §5.4 `Topic`: 22 base64url characters of sha256(channelId), so the vendor replaces an undelivered go-live of the same channel. */
export async function pushTopic(channelId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(channelId)));
  return b64url(digest.subarray(0, 16));
}

export interface PushRow {
  id: string;
  subscription: string;
}

type SendCtx = Pick<WorkerContext, "db" | "logger" | "now"> & {
  webhooks: Pick<WorkerContext["webhooks"], "authSecret" | "resolve">;
};

type Opened = { ok: true; sub: StoredSubscription } | { ok: false; reason: "secret" | "corrupt" };

async function openRow(authSecret: string, row: PushRow): Promise<Opened> {
  let plain: string;
  try {
    plain = await decryptSecret(authSecret, NOTIFY_SECRET_PURPOSES.pushSubscription, row.subscription);
  } catch {
    return { ok: false, reason: "secret" };
  }
  try {
    const parsed = StoredSubscription.safeParse(JSON.parse(plain));
    return parsed.success ? { ok: true, sub: parsed.data } : { ok: false, reason: "corrupt" };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

async function remove(ctx: SendCtx, id: string): Promise<void> {
  await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}

export interface SendOptions {
  /**
   * Count a 400/401/403 towards the failure limit. False on a job's retry attempts, so one
   * go-live counts once however often the job reruns for another browser's 429.
   */
  countRefusal: boolean;
}

/** Send `payload` to one stored subscription and apply the push service's answer to its row. */
export async function sendPush(
  ctx: SendCtx,
  push: WebPushSettings,
  row: PushRow,
  payload: PushPayload,
  channelId: string,
  opts: SendOptions = { countRefusal: true },
): Promise<PushOutcome> {
  const opened = await openRow(ctx.webhooks.authSecret, row);
  if (!opened.ok) {
    if (opened.reason === "secret") {
      // Usually this worker's AUTH_SECRET differs from the API's (a misconfigured replica): the row
      // is fine for a correctly configured worker, so keep it. A genuinely rotated secret leaves
      // rows that go when their owners turn push off or sign out.
      ctx.logger.error("push subscription cannot be decrypted with this worker's AUTH_SECRET", {
        subscriptionId: row.id,
      });
      return "failed";
    }
    // Decrypted, so the secret is right, but the content is not a subscription: it never will be.
    ctx.logger.warn("push subscription is corrupt; deleting it", { subscriptionId: row.id });
    await remove(ctx, row.id);
    return "removed";
  }
  const sub = opened.sub;

  let endpoint: URL;
  let uaPublic: Uint8Array;
  let uaAuth: Uint8Array;
  try {
    endpoint = new URL(sub.endpoint);
    uaPublic = fromB64url(sub.p256dh);
    uaAuth = fromB64url(sub.auth);
  } catch {
    // The API refuses these, so the row itself is bad and can never be sent to.
    ctx.logger.warn("push subscription endpoint or keys malformed; deleting it", { subscriptionId: row.id });
    await remove(ctx, row.id);
    return "removed";
  }

  let body: Uint8Array;
  try {
    body = await encryptPushPayload({
      plaintext: new TextEncoder().encode(JSON.stringify(payload)),
      uaPublic,
      authSecret: uaAuth,
    });
  } catch (err) {
    if (err instanceof PushKeyInvalid) {
      ctx.logger.warn("push subscription keys unusable; deleting it", { subscriptionId: row.id });
      await remove(ctx, row.id);
      return "removed";
    }
    // Our side (payload too large, a Web Crypto failure): the row is not to blame.
    ctx.logger.error("push payload could not be encrypted", {
      subscriptionId: row.id,
      error: err instanceof Error ? err.name : "unknown",
    });
    return "failed";
  }

  // Not caught here: a bad VAPID_PRIVATE_KEY is the instance's fault, never the row's. The job
  // checks the key before any send; should it still throw, the job counts the send as retryable.
  const authorization = await vapidAuthorization({
    endpoint: endpoint.href,
    subject: push.subject,
    publicKey: push.publicKey,
    privateKeyPkcs8: push.privateKeyPkcs8,
    now: ctx.now(),
  });

  const result = await postPinned(
    sub.endpoint,
    {
      headers: {
        TTL: String(NOTIFY_RULES.pushTtlSeconds),
        Urgency: "normal",
        Topic: await pushTopic(channelId),
        "Content-Encoding": "aes128gcm",
        Authorization: authorization,
      },
      body,
      contentType: "application/octet-stream",
      userAgent: PUSH_USER_AGENT,
    },
    {
      allowInsecure: push.allowInsecure,
      timeoutMs: PUSH_TIMEOUT_MS,
      maxResponseBytes: PUSH_MAX_RESPONSE_BYTES,
      ...(ctx.webhooks.resolve ? { resolve: ctx.webhooks.resolve } : {}),
    },
  );
  return applyVerdict(ctx, row.id, result, opts);
}

async function applyVerdict(ctx: SendCtx, id: string, result: PostResult, opts: SendOptions): Promise<PushOutcome> {
  const verdict = classifyPushResult(result);
  const status = result.ok ? result.status : null;
  switch (verdict) {
    case "success":
      await ctx.db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: ctx.now(), failures: 0 })
        .where(eq(pushSubscriptions.id, id));
      return "sent";
    case "expired":
      await remove(ctx, id);
      return "removed";
    case "unsendable":
      ctx.logger.warn("push endpoint refused by the address guard; deleting it", { subscriptionId: id });
      await remove(ctx, id);
      return "removed";
    case "too_large":
      // We bound the plaintext well below the record size: a 413 is our bug, and a retry would repeat it.
      ctx.logger.error("push service answered 413 (payload too large)", { subscriptionId: id });
      return "failed";
    case "retry":
      ctx.logger.info("push send will be retried", {
        subscriptionId: id,
        status,
        error: result.ok ? undefined : result.error,
      });
      return "retry";
    case "refused": {
      ctx.logger.warn("push service refused the message", { subscriptionId: id, status });
      if (!opts.countRefusal) return "failed";
      // One statement: concurrent jobs for the same member cannot lose an increment.
      const [counted] = await ctx.db
        .update(pushSubscriptions)
        .set({ failures: sql`${pushSubscriptions.failures} + 1` })
        .where(eq(pushSubscriptions.id, id))
        .returning({ failures: pushSubscriptions.failures });
      if (!counted || counted.failures < PUSH_FAILURE_LIMIT) return "failed";
      await remove(ctx, id);
      return "removed";
    }
  }
}
