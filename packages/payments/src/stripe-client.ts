// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A small Stripe API client on `fetch` (no SDK): form-encoded bodies, bearer auth, a pinned
 * `Stripe-Version`, idempotency keys on every POST, a timeout per attempt. Network errors and 5xx
 * are retried (POSTs are safe to retry under their idempotency key); 4xx never is. Only the calls
 * the adapter needs exist. Test keys only: a live key is refused before any request is made.
 *
 * Failures are classified (ADR 0007 decision 3): a 4xx is a definite `StripeRequestError`; a
 * timeout, a network error or a 5xx after the retries, or a success answer missing what the call
 * needs, is `StripeOutcomeUnknown`, because Stripe may have acted.
 */
import { StripeApiError, StripeOutcomeUnknown, StripeRequestError } from "./errors.ts";
import { type FormObject, encodeForm } from "./stripe-form.ts";

export { StripeApiError, StripeOutcomeUnknown, StripeRequestError } from "./errors.ts";

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

/** A Connect transfer (the fields the platform reads). Amounts are integer minor units. */
export interface StripeTransfer {
  id: string;
  amount: number;
  currency: string;
  /** The connected account id (`acct_…`). */
  destination: string;
  /** True once the whole amount was reversed. */
  reversed: boolean;
  amountReversed: number;
  /** Our metadata keys only (`payout_id`, `transfer_id`, …). */
  metadata: Record<string, string>;
}

/** A refund (the fields the reconciliation reads). */
export interface StripeRefund {
  id: string;
  amount: number;
  currency: string;
  /** `pending`, `requires_action`, `succeeded`, `failed` or `canceled`; null if Stripe sent none. */
  status: string | null;
  paymentIntent: string | null;
  metadata: Record<string, string>;
}

export interface StripeClient {
  createCheckoutSession(params: FormObject, idempotencyKey: string): Promise<{ id: string; url: string }>;
  /** `cancel_at_period_end=true`. */
  cancelSubscriptionAtPeriodEnd(subscriptionId: string, idempotencyKey: string): Promise<void>;
  /** Ends the subscription now. */
  cancelSubscriptionNow(subscriptionId: string, idempotencyKey: string): Promise<void>;
  createRefund(params: FormObject, idempotencyKey: string): Promise<{ id: string; status: string | null }>;
  createExpressAccount(params: FormObject, idempotencyKey: string): Promise<{ id: string }>;
  createAccountLink(params: FormObject, idempotencyKey: string): Promise<{ url: string }>;
  /** A Connect account's payout readiness. */
  retrieveAccount(accountId: string): Promise<{ id: string; payoutsEnabled: boolean }>;
  retrieveBalanceTransaction(id: string): Promise<{ feeCents: number; currency: string }>;
  /** Fee of a PaymentIntent's charge (its balance transaction), or null before it has one. */
  paymentIntentFee(paymentIntentId: string): Promise<{ feeCents: number; currency: string } | null>;
  /** `POST /v1/transfers` (Connect): move platform balance to a connected account. */
  createTransfer(params: FormObject, idempotencyKey: string): Promise<StripeTransfer>;
  retrieveTransfer(transferId: string): Promise<StripeTransfer>;
  retrieveRefund(refundId: string): Promise<StripeRefund>;
  /** Every refund of a PaymentIntent, newest first (follows Stripe's pagination). */
  listRefunds(params: { paymentIntent: string }): Promise<StripeRefund[]>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
/** An expandable field: the id string, or the expanded object's id. */
const ref = (v: unknown): string | null => str(v) ?? (isObj(v) ? str(v.id) : null);
const ID = /^[A-Za-z0-9_]{1,255}$/;
/** Pages `listRefunds` follows at most (100 refunds each); a PaymentIntent has a handful. */
const MAX_LIST_PAGES = 10;

function pathId(id: string): string {
  if (!ID.test(id)) throw new RangeError("not a Stripe object id");
  return id;
}

/** A success answer without what the call needs: Stripe may still have acted. */
const malformed = (what: string) => new StripeOutcomeUnknown(`Stripe returned ${what}`, 502, null, null);

function metadataOf(o: Json): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(o.metadata)) return out;
  for (const [k, v] of Object.entries(o.metadata)) if (typeof v === "string") out[k] = v;
  return out;
}

function feeOf(bt: unknown): { feeCents: number; currency: string } {
  const o = (bt ?? {}) as Json;
  const fee = int(o.fee);
  const currency = str(o.currency);
  if (fee === null || fee < 0 || currency === null) throw malformed("a malformed balance transaction");
  return { feeCents: fee, currency: currency.toLowerCase() };
}

/** Exported for tests. */
export function transferOf(o: Json): StripeTransfer {
  const id = str(o.id);
  const amount = int(o.amount);
  const currency = str(o.currency);
  const destination = ref(o.destination);
  if (!id || amount === null || !currency || !destination) throw malformed("a transfer without its id or amount");
  return {
    id,
    amount,
    currency: currency.toLowerCase(),
    destination,
    reversed: o.reversed === true,
    amountReversed: int(o.amount_reversed) ?? 0,
    metadata: metadataOf(o),
  };
}

/** Exported for tests. */
export function refundOf(o: unknown): StripeRefund {
  const r = isObj(o) ? o : {};
  const id = str(r.id);
  const amount = int(r.amount);
  const currency = str(r.currency);
  if (!id || amount === null || !currency) throw malformed("a refund without its id or amount");
  return {
    id,
    amount,
    currency: currency.toLowerCase(),
    status: str(r.status),
    paymentIntent: ref(r.payment_intent),
    metadata: metadataOf(r),
  };
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
      let text: string;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers,
          ...(body ? { body: encodeForm(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // A body cut off by the timeout is as unknown as no answer at all.
        text = await res.text();
      } catch (err) {
        lastError = err;
        continue;
      }
      let parsed: Json = {};
      try {
        parsed = text ? (JSON.parse(text) as Json) : {};
      } catch {
        parsed = {};
      }
      if (res.ok) return parsed;
      const e = (parsed.error ?? {}) as Json;
      const message = str(e.message) ?? `Stripe answered ${res.status}`;
      if (res.status < 500) throw new StripeRequestError(message, res.status, str(e.type), str(e.code));
      lastError = new StripeOutcomeUnknown(message, res.status, str(e.type), str(e.code));
    }
    if (lastError instanceof StripeApiError) throw lastError;
    throw new StripeOutcomeUnknown(`Stripe is unreachable: ${String(lastError)}`, 503, null, null);
  }

  return {
    async createCheckoutSession(params, key) {
      const r = await request("POST", "/v1/checkout/sessions", params, key);
      const id = str(r.id);
      const url = str(r.url);
      if (!id || !url) throw malformed("a checkout session without a url");
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
      if (!id) throw malformed("a refund without an id");
      return { id, status: str(r.status) };
    },
    async createExpressAccount(params, key) {
      const r = await request("POST", "/v1/accounts", params, key);
      const id = str(r.id);
      if (!id) throw malformed("an account without an id");
      return { id };
    },
    async createAccountLink(params, key) {
      const r = await request("POST", "/v1/account_links", params, key);
      const url = str(r.url);
      if (!url) throw malformed("an account link without a url");
      return { url };
    },
    async retrieveAccount(accountId) {
      const r = await request("GET", `/v1/accounts/${pathId(accountId)}`);
      return { id: str(r.id) ?? accountId, payoutsEnabled: r.payouts_enabled === true };
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
    async createTransfer(params, key) {
      return transferOf(await request("POST", "/v1/transfers", params, key));
    },
    async retrieveTransfer(transferId) {
      return transferOf(await request("GET", `/v1/transfers/${pathId(transferId)}`));
    },
    async retrieveRefund(refundId) {
      return refundOf(await request("GET", `/v1/refunds/${pathId(refundId)}`));
    },
    async listRefunds({ paymentIntent }) {
      const out: StripeRefund[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const q = new URLSearchParams({ payment_intent: pathId(paymentIntent), limit: "100" });
        if (after) q.set("starting_after", after);
        const r = await request("GET", `/v1/refunds?${q.toString()}`);
        const data = Array.isArray(r.data) ? r.data : null;
        if (!data) throw malformed("a refund list without data");
        const refunds = data.map(refundOf);
        out.push(...refunds);
        const last = refunds.at(-1);
        if (r.has_more !== true || !last) return out;
        after = last.id;
      }
      return out;
    },
  };
}
