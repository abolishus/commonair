// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Provider call errors, in their own module so callers on the manual path can classify them
 * without loading any Stripe code (`index.ts` re-exports this file; the client imports it).
 *
 * ADR 0007 decision 3 turns on the split below: after a definite refusal nothing happened at the
 * provider and the caller may release its guard; after an unknown outcome the provider may have
 * acted, so the caller keeps blocking and reconciles (retrying with the same idempotency key).
 */

/** Any answer from Stripe that is not a success. */
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

/** A definite refusal: Stripe answered 4xx, so the request did nothing (never retried). */
export class StripeRequestError extends StripeApiError {
  override name = "StripeRequestError";
}

/**
 * The outcome is unknown: a timeout, a network error, or a 5xx after the client's retries, or a
 * success answer without the fields the call needs. Stripe may have done what was asked.
 */
export class StripeOutcomeUnknown extends StripeApiError {
  override name = "StripeOutcomeUnknown";
}

/** True when the provider may have acted on the request (see `StripeOutcomeUnknown`). */
export const isOutcomeUnknown = (err: unknown): err is StripeOutcomeUnknown => err instanceof StripeOutcomeUnknown;
/** True for a definite refusal (see `StripeRequestError`). */
export const isDefiniteRefusal = (err: unknown): err is StripeRequestError => err instanceof StripeRequestError;
