// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `POST /api/webhooks/stripe`. Loaded by http.ts only while `PAYMENTS_PROVIDER=stripe`.
 *
 * Raw body (capped) → `Stripe-Signature` check (400 on failure) → stored in `payment_events`
 * (unique per event id) before anything else → applied in its own transaction that also marks
 * the row processed. A failure records `error` and `attempts` and answers 500 so Stripe retries;
 * a redelivery of a processed event answers 200 without touching anything. No cookies, no CORS:
 * Stripe is the only caller, authenticated by the signature.
 */
import { eq, sql } from "drizzle-orm";
import { KEYS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { createAdapter, loadStripeEvents, loadStripeSignature } from "@commonair/payments";
import type { Deps } from "../deps.ts";
import { invalidateSubscribers } from "./checkout-shared.ts";
import { type AppliedAction, applyStripeAction, prepareStripeAction } from "./stripe-events.ts";

const { paymentEvents } = schema;

export const STRIPE_WEBHOOK_PATH = "/api/webhooks/stripe";
/** Stripe's events are well under this; anything larger is not from Stripe. */
export const STRIPE_WEBHOOK_MAX_BODY = 512 * 1024;
/**
 * Its own bucket (`rl:stripe-webhook:<ip>`), generous: Stripe bursts on retries and shares a
 * few addresses. Bucket name and rule are local until the contracts list it (contract request).
 */
export const STRIPE_WEBHOOK_RATE_LIMIT = { max: 600, windowMs: 60_000 } as const;
const STRIPE_WEBHOOK_BUCKET = "stripe-webhook";
const ERROR_MAX = 500;

const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function readCapped(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > STRIPE_WEBHOOK_MAX_BODY) return null;
  if (!req.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > STRIPE_WEBHOOK_MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const message = (err: unknown) =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, ERROR_MAX);

export async function handleStripeWebhook(deps: Deps, req: Request, rateLimitSubject: string): Promise<Response> {
  // Platform events (checkout, invoices, charges) and Connect events (connected accounts'
  // `account.updated`) come from two Stripe endpoints with their own secrets; either may sign.
  const secrets = [
    { secret: deps.env.STRIPE_WEBHOOK_SECRET, connect: false },
    { secret: deps.env.STRIPE_CONNECT_WEBHOOK_SECRET, connect: true },
  ].filter((s): s is { secret: string; connect: boolean } => typeof s.secret === "string" && s.secret.length > 0);
  if (deps.env.PAYMENTS_PROVIDER !== "stripe" || secrets.length === 0)
    return reply(404, { code: "NOT_FOUND", message: "Not found" });
  if (req.method !== "POST") return reply(405, { code: "METHOD_NOT_ALLOWED", message: "POST only" });

  const nowMs = deps.now().getTime();
  const rl = await deps.rateLimitStore.hit(
    KEYS.rateLimit(STRIPE_WEBHOOK_BUCKET, `ip:${rateLimitSubject}`),
    STRIPE_WEBHOOK_RATE_LIMIT,
    nowMs,
    `${nowMs}:${crypto.randomUUID()}`,
  );
  if (!rl.allowed) {
    const res = reply(429, { code: "RATE_LIMITED", message: "Too many requests" });
    res.headers.set("retry-after", String(rl.retryAfterSeconds));
    return res;
  }

  const raw = await readCapped(req);
  if (raw === null) return reply(413, { code: "PAYLOAD_TOO_LARGE", message: "Body too large" });
  const { verifyStripeSignature } = await loadStripeSignature();
  const header = req.headers.get("stripe-signature");
  let check: Awaited<ReturnType<typeof verifyStripeSignature>> = { ok: false, reason: "missing" };
  let viaConnect = false;
  for (const s of secrets) {
    check = await verifyStripeSignature(raw, header, s.secret, { nowS: Math.floor(nowMs / 1000) });
    if (check.ok) {
      viaConnect = s.connect;
      break;
    }
  }
  if (!check.ok) return reply(400, { code: "BAD_SIGNATURE", message: `Signature ${check.reason}` });

  const { redactStripeEvent, stripeAction, stripeEnvelope } = await loadStripeEvents();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return reply(400, { code: "BAD_REQUEST", message: "Body is not JSON" });
  }
  // Only what the processor reads is kept and processed (no payer details), so a replay of the row acts alike.
  const stored = redactStripeEvent(body);
  const envelope = stripeEnvelope(stored);
  if (!envelope) return reply(400, { code: "BAD_REQUEST", message: "Not a Stripe event" });
  // This build runs Stripe in test mode only (config refuses live keys); refuse live events too.
  if (envelope.livemode) return reply(400, { code: "BAD_REQUEST", message: "Live-mode events are refused" });

  const [inserted] = await deps.db
    .insert(paymentEvents)
    .values({ provider: "stripe", providerEventId: envelope.id, type: envelope.type, payload: stored })
    .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.providerEventId] })
    .returning({ id: paymentEvents.id });
  let rowId = inserted?.id;
  if (!rowId) {
    const [existing] = await deps.db
      .select({ id: paymentEvents.id, processedAt: paymentEvents.processedAt })
      .from(paymentEvents)
      .where(sql`${paymentEvents.provider} = 'stripe' and ${paymentEvents.providerEventId} = ${envelope.id}`);
    if (!existing) return reply(500, { code: "INTERNAL_SERVER_ERROR", message: "Event not stored" });
    if (existing.processedAt) return reply(200, { received: true, duplicate: true });
    rowId = existing.id;
  }
  const id = rowId;

  let applied: AppliedAction | null;
  try {
    // The Connect endpoint's secret vouches for connected-account events only: anything else it
    // signs is stored but never moves money.
    const action =
      viaConnect && envelope.type !== "account.updated" ? ({ type: "ignored" } as const) : stripeAction(envelope);
    const prepared = await prepareStripeAction(createAdapter(deps.env), action);
    applied = await deps.db.transaction(async (tx) => {
      // A concurrent redelivery waits here and then finds the event processed.
      const [row] = await tx
        .select({ processedAt: paymentEvents.processedAt })
        .from(paymentEvents)
        .where(eq(paymentEvents.id, id))
        .for("update");
      if (!row || row.processedAt) return null;
      const now = deps.now();
      const result = await applyStripeAction(tx, action, prepared, now);
      await tx
        .update(paymentEvents)
        .set({ processedAt: now, error: null, attempts: sql`${paymentEvents.attempts} + 1` })
        .where(eq(paymentEvents.id, id));
      return result;
    });
  } catch (err) {
    await deps.db
      .update(paymentEvents)
      .set({ error: message(err), attempts: sql`least(${paymentEvents.attempts} + 1, 32767)` })
      .where(eq(paymentEvents.id, id));
    deps.logger.error("stripe event failed", { eventType: envelope.type, eventId: envelope.id, err });
    return reply(500, { code: "INTERNAL_SERVER_ERROR", message: "Event not processed; it will be retried" });
  }
  if (!applied) return reply(200, { received: true, duplicate: true });

  deps.logger.info("stripe event processed", {
    eventType: envelope.type,
    eventId: envelope.id,
    outcome: applied.outcome,
  });
  for (const i of applied.invalidate) await invalidateSubscribers(deps, i.channelId, i.userIds);
  if (applied.cancelProviderSubscriptions.length > 0) {
    // Our side ended these subscriptions (clawback): stop Stripe charging them. Best effort; an
    // operator can end them in Stripe, and the later `customer.subscription.deleted` is a no-op.
    const adapter = createAdapter(deps.env);
    for (const ref of new Set(applied.cancelProviderSubscriptions)) {
      try {
        await adapter.cancelSubscription?.(ref, { atPeriodEnd: false, idempotencyKey: `end-${ref}` });
      } catch (err) {
        deps.logger.warn("could not end a Stripe subscription after a clawback", { eventId: envelope.id, err });
      }
    }
  }
  return reply(200, { received: true, outcome: applied.outcome });
}
