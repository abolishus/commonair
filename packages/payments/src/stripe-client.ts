// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A small Stripe API client on `fetch` (no SDK): form-encoded bodies, bearer auth, a pinned
 * `Stripe-Version`, idempotency keys on every POST, a timeout per attempt. Network errors and 5xx
 * are retried (POSTs are safe to retry under their idempotency key); 4xx never is. Only the calls
 * the adapter needs exist. Test keys only: a live key is refused before any request is made.
 */
import { type FormObject, encodeForm } from "./stripe-form.ts";

/** Webhook endpoints must be created with this version too: the event parser reads its shapes. */
export const STRIPE_API_VERSION = "2024-06-20";
export const STRIPE_DEFAULT_API_BASE = "https://api.stripe.com";

export interface StripeClientOptions {
  secretKey: string;
  /** e.g. stripe-mock in the harness. */
  apiBase?: string | undefined;
  timeoutMs?: number;
  /** Extra attempts after a network error or 5xx. */
  retries?: number;
  fetch?: typeof fetch;
}

export class StripeApiError extends Error {
  override name = "StripeApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export class StripeKeyError extends Error {
  override name = "StripeKeyError";
}

/** Only test-mode secret or restricted keys (`sk_test_…`, `rk_test_…`) are accepted in this build. */
export function stripeKeyProblem(key: string | undefined): string | null {
  if (!key) return "STRIPE_SECRET_KEY is not set";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live Stripe keys are refused";
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) return "STRIPE_SECRET_KEY must be a test key";
  return null;
}

export function assertTestKey(key: string | undefined): asserts key is string {
  const problem = stripeKeyProblem(key);
  if (problem) throw new StripeKeyError(problem);
}

type Json = Record<string, unknown>;

export interface StripeClient {
  createCheckoutSession(params: FormObject, idempotencyKey: string): Promise<{ id: string; url: string }>;
  /** `cancel_at_period_end=true`. */
  cancelSubscriptionAtPeriodEnd(subscriptionId: string, idempotencyKey: string): Promise<void>;
  /** Ends the subscription now. */
  cancelSubscriptionNow(subscriptionId: string, idempotencyKey: string): Promise<void>;
  createRefund(params: FormObject, idempotencyKey: string): Promise<{ id: string; status: string | null }>;
  createExpressAccount(params: FormObject, idempotencyKey: string): Promise<{ id: string }>;
  createAccountLink(params: FormObject, idempotencyKey: string): Promise<{ url: string }>;
  retrieveBalanceTransaction(id: string): Promise<{ feeCents: number; currency: string }>;
  /** Fee of a PaymentIntent's charge (its balance transaction), or null before it has one. */
  paymentIntentFee(paymentIntentId: string): Promise<{ feeCents: number; currency: string } | null>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const ID = /^[A-Za-z0-9_]{1,255}$/;

function pathId(id: string): string {
  if (!ID.test(id)) throw new RangeError("not a Stripe object id");
  return id;
}

function feeOf(bt: unknown): { feeCents: number; currency: string } {
  const o = (bt ?? {}) as Json;
  const fee = int(o.fee);
  const currency = str(o.currency);
  if (fee === null || fee < 0 || currency === null)
    throw new StripeApiError("malformed balance transaction", 502, null, null);
  return { feeCents: fee, currency: currency.toLowerCase() };
}

export function stripeClient(opts: StripeClientOptions): StripeClient {
  assertTestKey(opts.secretKey);
  const base = (opts.apiBase ?? STRIPE_DEFAULT_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;

  async function request(method: "GET" | "POST" | "DELETE", path: string, body?: FormObject, key?: string) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.secretKey}`,
      "stripe-version": STRIPE_API_VERSION,
      accept: "application/json",
    };
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    if (key) headers["idempotency-key"] = key;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await Bun.sleep(200 * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers,
          ...(body ? { body: encodeForm(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastError = err;
        continue;
      }
      const text = await res.text();
      let parsed: Json = {};
      try {
        parsed = text ? (JSON.parse(text) as Json) : {};
      } catch {
        parsed = {};
      }
      if (res.ok) return parsed;
      const e = (parsed.error ?? {}) as Json;
      const error = new StripeApiError(
        str(e.message) ?? `Stripe answered ${res.status}`,
        res.status,
        str(e.type),
        str(e.code),
      );
      if (res.status < 500) throw error;
      lastError = error;
    }
    if (lastError instanceof StripeApiError) throw lastError;
    throw new StripeApiError(`Stripe is unreachable: ${String(lastError)}`, 503, null, null);
  }

  return {
    async createCheckoutSession(params, key) {
      const r = await request("POST", "/v1/checkout/sessions", params, key);
      const id = str(r.id);
      const url = str(r.url);
      if (!id || !url) throw new StripeApiError("Stripe returned a checkout session without a url", 502, null, null);
      return { id, url };
    },
    async cancelSubscriptionAtPeriodEnd(subscriptionId, key) {
      await request("POST", `/v1/subscriptions/${pathId(subscriptionId)}`, { cancel_at_period_end: true }, key);
    },
    async cancelSubscriptionNow(subscriptionId, key) {
      await request("DELETE", `/v1/subscriptions/${pathId(subscriptionId)}`, undefined, key);
    },
    async createRefund(params, key) {
      const r = await request("POST", "/v1/refunds", params, key);
      const id = str(r.id);
      if (!id) throw new StripeApiError("Stripe returned a refund without an id", 502, null, null);
      return { id, status: str(r.status) };
    },
    async createExpressAccount(params, key) {
      const r = await request("POST", "/v1/accounts", params, key);
      const id = str(r.id);
      if (!id) throw new StripeApiError("Stripe returned an account without an id", 502, null, null);
      return { id };
    },
    async createAccountLink(params, key) {
      const r = await request("POST", "/v1/account_links", params, key);
      const url = str(r.url);
      if (!url) throw new StripeApiError("Stripe returned an account link without a url", 502, null, null);
      return { url };
    },
    async retrieveBalanceTransaction(id) {
      return feeOf(await request("GET", `/v1/balance_transactions/${pathId(id)}`));
    },
    async paymentIntentFee(paymentIntentId) {
      const r = await request(
        "GET",
        `/v1/payment_intents/${pathId(paymentIntentId)}?expand[]=latest_charge.balance_transaction`,
      );
      const charge = r.latest_charge;
      if (charge === null || charge === undefined) return null;
      if (typeof charge === "string") return null;
      const bt = (charge as Json).balance_transaction;
      if (bt === null || bt === undefined) return null;
      if (typeof bt === "string") return this.retrieveBalanceTransaction(bt);
      return feeOf(bt);
    },
  };
}
