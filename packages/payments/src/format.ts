// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Plain-text money for operator-written messages (payment instructions). Integer arithmetic on the
 * ISO 4217 minor units, so every engine prints the same thing; the web app uses `formatMoney` for UI.
 */
import { minorUnits } from "@commonair/contracts/currency";

/** `1234, "usd"` → `"12.34 USD"`; `500, "jpy"` → `"500 JPY"`; negative amounts keep their sign. */
export function formatPlainAmount(cents: number, currency: string): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError("amount must be integer minor units");
  const digits = minorUnits(currency);
  const sign = cents < 0 ? "-" : "";
  const abs = BigInt(Math.abs(cents));
  const unit = 10n ** BigInt(digits);
  const major = (abs / unit).toString();
  const minor = digits > 0 ? `.${(abs % unit).toString().padStart(digits, "0")}` : "";
  return `${sign}${major}${minor} ${currency.toUpperCase()}`;
}

/** Fill `{reference}` and `{amount}` (every occurrence) in an operator template. */
export function fillInstructions(template: string, values: { reference: string; amount: string }): string {
  return template.replace(/\{(reference|amount)\}/g, (_, key: "reference" | "amount") => values[key]);
}
