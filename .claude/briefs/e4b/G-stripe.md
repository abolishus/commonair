<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4b unit G, the Stripe adapter** for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md, PLAN.md, docs/architecture.md, ADR 0003 §7 and
`.claude/briefs/e4b/_common.md` first, then `docs/testing/e4b-selectors.md` in full (the
"Stripe adapter" section is your spec), `packages/payments/**`, `services/api/src/money/**` and
its README (the manual adapter you extend), and `harness/scenarios/e4b-money.ts`. Do not look
outside the repository.

## You own (write only these)

- `packages/payments/src/stripe*.ts` (new), `packages/payments/src/index.ts`,
  `packages/payments/src/adapter.ts` (extend the interface), `packages/payments/tests/stripe*`,
  `packages/payments/README.md`
- `services/api/src/money/stripe*.ts` (new: webhook handler and event processing),
  `services/api/src/http.ts` (mount `POST /api/webhooks/stripe` only),
  `services/api/src/money/checkout*.ts` and `services/api/src/money/reports*.ts` only where the
  Stripe path differs (redirect checkout, Stripe cancel, Connect onboarding in `payoutAccount`),
  `services/api/tests/money-stripe*`, the Stripe part of `services/api/src/money/README.md`
- `harness/scenarios/e4b-money.ts` and `harness/src/money*.ts` (add `--set provider=stripe`),
  `harness/src/stripe*.ts` (new: event signing), `harness/tests/stripe*`

## Contracts you must honor (read-only for you)

- `paymentsEnv` (`STRIPE_SECRET_KEY` test keys only, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_BASE`),
  `CheckoutResult` `redirect`, `payment_events` (store every event before processing, unique per
  `(provider, provider_event_id)`, `processed_at`/`error`/`attempts`), the same state transitions,
  ledger postings, events and audit rows as the manual adapter (spec table), `payout_accounts`
  (`provider: stripe`, `provider_account_id` = the Connect account id).
- stripe-mock (`docker.io/stripe/stripe-mock:v0.206.0`, compose profile `stripe`) is stateless:
  it validates requests and returns fixtures. Webhooks never come from it.

## Build

1. **No SDK.** A small `fetch` client (form-encoded bodies, `Authorization: Bearer`,
   `Stripe-Version` pinned, idempotency keys = our payment id, timeouts, no retries on 4xx) for
   exactly: Checkout Sessions create (`mode=subscription` with `price_data` + `recurring` for
   self subscriptions; `mode=payment` for gifts and tips; `metadata.payment_id`, `client_reference_id`;
   success/cancel URLs from `PUBLIC_URL` + `returnPath`), subscription cancel at period end,
   refunds create, Connect Express accounts create + account links create, balance transaction
   retrieve (fees). No Stripe code runs or is imported when `PAYMENTS_PROVIDER=manual` (lazy
   import behind `createAdapter`).
2. **Webhook** `POST /api/webhooks/stripe`: raw body, verify `Stripe-Signature` (`t=`, `v1=`
   HMAC-SHA256 of `${t}.${body}` with `STRIPE_WEBHOOK_SECRET`, constant-time compare, 5-minute
   tolerance, several `v1` allowed), insert into `payment_events` (duplicate → 200, no reprocess),
   process in its own transaction, mark processed or record `error` + `attempts` and answer 500
   so Stripe retries; 400 on a bad signature; unknown event types → stored, processed as no-ops.
   No cookies, no CORS, a body size cap, its own rate limit bucket.
3. **Event mapping** (spec): `checkout.session.completed` (payment mode → confirm the payment;
   subscription mode → record `providerRef` = Stripe subscription id, confirm the first
   payment), `invoice.paid` (renewals: confirm or create+confirm the period's payment, idempotent
   on the invoice id), `invoice.payment_failed` → `past_due`, `customer.subscription.deleted` →
   `canceled`, `charge.refunded` → refund (amount from the event, idempotent per refund id),
   `charge.dispute.created` → chargeback (`disputes` `open`, claw back now),
   `charge.dispute.closed` won → reverse the clawback (`chargeback_reversal`), lost → close.
   Fees and tax come from the event / balance transaction and are posted with the payment.
4. **Connect**: `payoutAccount` for Stripe creates the Express account on first call and returns
   an account link `onboardingUrl`; `account.updated` with `payouts_enabled` updates
   `payout_accounts`. Payout runs for Stripe creators record `provider: stripe` payouts; actual
   transfers are out of scope (document it).
5. **Harness**: `--set provider=stripe` runs `e4b-money` against `PAYMENTS_PROVIDER=stripe` +
   stripe-mock: checkout returns a redirect (assert the URL shape, do not follow it), then the
   harness signs and posts the Stripe events that complete each step (Stripe's documented
   scheme, `HARNESS_STRIPE_WEBHOOK_SECRET` = the instance's secret) and asserts the same figures
   (now with fees).

## Tests you must add

- Unit: signature verification (valid, tampered body, old timestamp, multiple v1, wrong secret),
  form encoding of nested params, event → transition mapping, live-key refusal.
- Integration (`createTestDatabase()`, a local `Bun.serve` fake for the Stripe API where
  stripe-mock's fixtures are not enough; stripe-mock itself only if it is reachable, skip
  otherwise): each event type end to end through the webhook route, duplicate delivery, out-of-
  order `invoice.paid` before `checkout.session.completed`, dispute won/lost, refund via event.

## Done means

See `_common.md` "Done means". Packages: `packages/payments`, `services/api`, `harness`.
