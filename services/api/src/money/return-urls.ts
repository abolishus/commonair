// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a payment provider sends the payer back (design overhaul F12). Success and cancel differ,
 * and both name the payment, so the page can say "confirming your payment" or "checkout canceled"
 * and poll that payment instead of guessing. The webhook stays the only thing that settles it.
 */

export type CheckoutOutcome = "success" | "canceled";

/** `path` on `publicUrl` with `checkout=<outcome>&payment=<id>` added to any query it has. */
export function checkoutReturnUrl(
  publicUrl: string,
  path: string,
  outcome: CheckoutOutcome,
  paymentId: string,
): string {
  // Concatenated, not resolved: `path` is a validated `ReturnPath`, and PUBLIC_URL may carry a prefix.
  const url = new URL(`${publicUrl.replace(/\/+$/, "")}${path}`);
  // A fragment would end up before the provider's own parameters; it means nothing to the server.
  url.hash = "";
  url.searchParams.delete("checkout");
  url.searchParams.delete("payment");
  url.searchParams.set("checkout", outcome);
  url.searchParams.set("payment", paymentId);
  return url.toString();
}

/** Both return URLs of one payment's checkout. */
export function checkoutReturnUrls(
  publicUrl: string,
  path: string,
  paymentId: string,
): { successUrl: string; cancelUrl: string } {
  return {
    successUrl: checkoutReturnUrl(publicUrl, path, "success", paymentId),
    cancelUrl: checkoutReturnUrl(publicUrl, path, "canceled", paymentId),
  };
}
