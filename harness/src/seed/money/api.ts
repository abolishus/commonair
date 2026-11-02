// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-money's API side: signed-in sessions (each user once, waiting out the sign-in rate limit),
 * a retry on `RATE_LIMITED`, and the payment rail that settles and reverses checkouts the way the
 * provider would: the treasurer's confirm, refund and chargeback on the manual adapter, signed
 * Stripe webhooks against stripe-mock otherwise (`src/stripe.ts`, as `e4b-money` does).
 */
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import type { DbHandle } from "@commonair/db";
import type { ApiClient } from "../../api/client.ts";
import type { HarnessEnv } from "../../env.ts";
import type { CheckoutView } from "../../money-actors.ts";
import type { Provider } from "../../money.ts";
import {
  StripeWebhook,
  chargeRefunded,
  dispute,
  firstInvoicePaid,
  paymentCompleted,
  stripeEvent,
  stripeId,
  subscriptionCheckoutCompleted,
} from "../../stripe.ts";
import { AuthError, type SignedInUser, UserFactory } from "../../users.ts";
import { sleep } from "../../wait.ts";
import type { SeededUser } from "../types.ts";
import { expireCheckout, lapseSubscription } from "./db.ts";
import type { ChargebackOutcome, PaymentSpec } from "./plan.ts";

/** How long to keep retrying one rate-limited call before giving up. */
const MAX_RATE_WAIT_MS = 5 * 60_000;
/** `receivedAt` safely in the past (the API refuses the future; clocks drift). */
const RECEIVED_SKEW_MS = 5_000;

function retryAfterMs(err: unknown): number | null {
  if (err instanceof AuthError && err.status === 429) {
    const m = /"retryAfterSeconds"\s*:\s*(\d+)/.exec(err.message);
    return (m ? Number(m[1]) : 6) * 1000 + 250;
  }
  const e = err as { code?: unknown; data?: { retryAfterSeconds?: unknown } } | null;
  if (e && typeof e === "object" && e.code === "RATE_LIMITED") {
    const s = e.data?.retryAfterSeconds;
    return (typeof s === "number" && s > 0 ? s : 2) * 1000 + 250;
  }
  return null;
}

/**
 * Run `f`, waiting out `RATE_LIMITED` answers (the API's per-user and per-address limits apply to
 * the seed like any client); anything else fails loudly with what was being done.
 */
export async function call<T>(what: string, f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const started = Date.now();
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await f();
    } catch (err) {
      const wait = retryAfterMs(err);
      if (wait === null || Date.now() - started > MAX_RATE_WAIT_MS)
        throw new Error(`seed-money: ${what} failed: ${String(err)}`, { cause: err });
      await sleep(wait, signal);
    }
  }
}

/** Signs each seeded account in once and keeps the session. */
export class MoneySessions {
  private readonly cache = new Map<string, Promise<SignedInUser>>();
  private readonly factory: UserFactory;

  constructor(
    env: HarnessEnv,
    private readonly password: string,
    private readonly users: ReadonlyMap<string, SeededUser>,
    private readonly signal?: AbortSignal,
  ) {
    this.factory = new UserFactory({
      apiUrl: env.HARNESS_API_URL,
      webOrigin: new URL(env.HARNESS_WEB_URL).origin,
      mailpitUrl: env.HARNESS_MAILPIT_URL,
      mailpitAuth: env.HARNESS_MAILPIT_AUTH,
      emailDomain: DEMO_FIXTURES.emailDomain,
    });
  }

  as(handle: string): Promise<SignedInUser> {
    let p = this.cache.get(handle);
    if (!p) {
      const u = this.users.get(handle);
      if (!u) throw new Error(`seed-money: no seeded user "${handle}" (seed-social runs first)`);
      p = call(
        `sign-in as ${handle}`,
        () =>
          this.factory.signIn({
            username: u.username,
            displayName: "",
            email: u.email,
            password: this.password,
            birthDate: "",
          }),
        this.signal,
      );
      this.cache.set(handle, p);
    }
    return p;
  }

  async client(handle: string): Promise<ApiClient> {
    return (await this.as(handle)).api.client;
  }

  get signedIn(): number {
    return this.cache.size;
  }
}

/** A settled payment, as later steps address it. */
export interface Paid {
  paymentId: string;
  /** Stripe: the PaymentIntent that paid it (refunds and disputes name it). */
  paymentIntent: string | null;
  /** Stripe self subscriptions: the Stripe subscription id. */
  stripeSubscription: string | null;
}

export interface Rail {
  readonly provider: Provider;
  /** Signed provider events delivered (each is a `payment_events` row). */
  readonly webhooks: number;
  confirm(spec: PaymentSpec, checkout: CheckoutView): Promise<Paid>;
  /** Let an unpaid checkout expire. */
  abandon(spec: PaymentSpec, paymentId: string): Promise<void>;
  /** A paid self subscription misses its renewal (past_due). */
  lapse(spec: PaymentSpec, paid: Paid): Promise<void>;
  refund(spec: PaymentSpec, paid: Paid, cents: number, reason: string): Promise<void>;
  /** False when this outcome cannot happen on this provider (skipped, and noted). */
  chargeback(spec: PaymentSpec, paid: Paid, outcome: ChargebackOutcome, reason: string): Promise<boolean>;
}

const receivedAt = () => new Date(Date.now() - RECEIVED_SKEW_MS).toISOString();

/** The manual adapter: the treasurer records what arrived and what went back. */
export class ManualRail implements Rail {
  readonly provider = "manual" as const;
  readonly webhooks = 0;

  constructor(
    private readonly treasurer: ApiClient,
    private readonly db: DbHandle,
    private readonly signal?: AbortSignal,
  ) {}

  async confirm(spec: PaymentSpec, checkout: CheckoutView): Promise<Paid> {
    await call(
      `treasurer confirms ${spec.key}`,
      () =>
        this.treasurer.money.treasurer.confirm({ paymentId: checkout.paymentId, receivedAt: receivedAt(), note: "" }),
      this.signal,
    );
    return { paymentId: checkout.paymentId, paymentIntent: null, stripeSubscription: null };
  }

  async abandon(spec: PaymentSpec, paymentId: string): Promise<void> {
    const n = await expireCheckout(this.db, paymentId, new Date(Date.now() - 60_000));
    if (n !== 1) throw new Error(`seed-money: could not let checkout ${spec.key} expire`);
  }

  async lapse(spec: PaymentSpec, paid: Paid): Promise<void> {
    const n = await lapseSubscription(this.db, paid.paymentId, new Date(Date.now() - 60_000));
    if (n !== 1) throw new Error(`seed-money: could not end the period of subscription ${spec.key}`);
  }

  async refund(spec: PaymentSpec, paid: Paid, cents: number, reason: string): Promise<void> {
    await call(
      `treasurer refunds ${spec.key}`,
      () => this.treasurer.money.treasurer.refund({ paymentId: paid.paymentId, amountCents: cents, reason }),
      this.signal,
    );
  }

  async chargeback(spec: PaymentSpec, paid: Paid, outcome: ChargebackOutcome, reason: string): Promise<boolean> {
    // A manual chargeback is lost on record at once; open and won disputes come only from a provider.
    if (outcome !== "lost") return false;
    await call(
      `treasurer records a chargeback on ${spec.key}`,
      () => this.treasurer.money.treasurer.chargeback({ paymentId: paid.paymentId, amountCents: spec.cents, reason }),
      this.signal,
    );
    return true;
  }
}

/** Stripe through stripe-mock: the harness sends the events Stripe would, signed with the instance secret. */
export class StripeRail implements Rail {
  readonly provider = "stripe" as const;
  private delivered = 0;
  private readonly hook: StripeWebhook;

  constructor(
    apiUrl: string,
    secret: string,
    private readonly treasurer: ApiClient,
    private readonly signal?: AbortSignal,
  ) {
    this.hook = new StripeWebhook(apiUrl, secret, signal);
  }

  get webhooks(): number {
    return this.delivered;
  }

  private async send(what: string, event: ReturnType<typeof stripeEvent>, outcome?: string): Promise<void> {
    // The webhook has its own per-address limit; a 429 is waited out, anything else non-2xx fails.
    const d = await call(
      what,
      async () => {
        const r = await this.hook.deliver(event);
        if (r.status === 429) throw Object.assign(new Error("webhook rate limited"), { code: "RATE_LIMITED" });
        if (r.status < 200 || r.status > 299)
          throw new Error(`webhook answered ${r.status}: ${JSON.stringify(r.body)}`);
        return r;
      },
      this.signal,
    );
    this.delivered++;
    if (outcome && d.body.outcome !== outcome)
      throw new Error(`seed-money: ${what}: expected outcome ${outcome}, got ${JSON.stringify(d.body)}`);
  }

  async confirm(spec: PaymentSpec, checkout: CheckoutView): Promise<Paid> {
    const pi = stripeId("pi");
    const money = { paymentId: checkout.paymentId, amountCents: spec.cents, currency: spec.currency };
    if (spec.kind === "sub") {
      const ids = { invoice: stripeId("in"), subscription: stripeId("sub") };
      await this.send(
        `invoice.paid for ${spec.key}`,
        firstInvoicePaid({ ...money, ...ids, paymentIntent: pi }),
        "confirmed",
      );
      await this.send(
        `checkout.session.completed for ${spec.key}`,
        subscriptionCheckoutCompleted({ ...money, ...ids }),
      );
      return { paymentId: checkout.paymentId, paymentIntent: pi, stripeSubscription: ids.subscription };
    }
    await this.send(
      `checkout.session.completed for ${spec.key}`,
      paymentCompleted({ ...money, paymentIntent: pi }),
      "confirmed",
    );
    return { paymentId: checkout.paymentId, paymentIntent: pi, stripeSubscription: null };
  }

  async abandon(spec: PaymentSpec, paymentId: string): Promise<void> {
    await this.send(
      `checkout.session.expired for ${spec.key}`,
      stripeEvent("checkout.session.expired", {
        id: stripeId("cs_test"),
        object: "checkout.session",
        mode: spec.kind === "sub" ? "subscription" : "payment",
        status: "expired",
        payment_status: "unpaid",
        client_reference_id: paymentId,
        metadata: { payment_id: paymentId },
      }),
    );
  }

  async lapse(spec: PaymentSpec, paid: Paid): Promise<void> {
    if (!paid.stripeSubscription) throw new Error(`seed-money: ${spec.key} has no Stripe subscription to lapse`);
    await this.send(
      `invoice.payment_failed for ${spec.key}`,
      stripeEvent("invoice.payment_failed", {
        id: stripeId("in"),
        object: "invoice",
        billing_reason: "subscription_cycle",
        status: "open",
        subscription: paid.stripeSubscription,
        amount_due: spec.cents,
        currency: spec.currency,
      }),
    );
  }

  async refund(spec: PaymentSpec, paid: Paid, cents: number, reason: string): Promise<void> {
    if (!paid.paymentIntent) throw new Error(`seed-money: ${spec.key} has no PaymentIntent to refund`);
    const pi = paid.paymentIntent;
    // The treasurer asks Stripe (stripe-mock answers); the posting follows Stripe's event.
    await call(
      `treasurer asks Stripe to refund ${spec.key}`,
      () => this.treasurer.money.treasurer.refund({ paymentId: paid.paymentId, amountCents: cents, reason }),
      this.signal,
    );
    await this.send(
      `charge.refunded for ${spec.key}`,
      chargeRefunded({
        paymentIntent: pi,
        refundId: stripeId("re"),
        amountCents: spec.cents,
        amountRefunded: cents,
        currency: spec.currency,
      }),
      "refunded",
    );
  }

  async chargeback(spec: PaymentSpec, paid: Paid, outcome: ChargebackOutcome): Promise<boolean> {
    if (!paid.paymentIntent) throw new Error(`seed-money: ${spec.key} has no PaymentIntent to dispute`);
    const ids = {
      disputeId: stripeId("dp"),
      paymentIntent: paid.paymentIntent,
      amountCents: spec.cents,
      currency: spec.currency,
    };
    await this.send(
      `charge.dispute.created for ${spec.key}`,
      dispute("charge.dispute.created", { ...ids, status: "needs_response" }),
      "charged_back",
    );
    if (outcome !== "open")
      await this.send(
        `charge.dispute.closed (${outcome}) for ${spec.key}`,
        dispute("charge.dispute.closed", { ...ids, status: outcome }),
        outcome,
      );
    return true;
  }
}

/** Run `f` over `items` with at most `limit` in flight; the first failure stops new work and rethrows. */
export async function pool<T>(items: readonly T[], limit: number, f: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (failed === null && next < items.length) {
      const item = items[next++] as T;
      try {
        await f(item);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed !== null) throw failed;
}
