// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe's `application/x-www-form-urlencoded` request bodies: nested objects become
 * `a[b][c]=v`, arrays `a[0][b]=v`. `undefined` and `null` are left out; booleans are `true`/`false`.
 */
export type FormValue = string | number | boolean | null | undefined | readonly FormValue[] | FormObject;
export interface FormObject {
  readonly [key: string]: FormValue;
}

/** The flattened `[key, value]` pairs, in insertion order. */
export function formPairs(params: FormObject, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  const walk = (key: string, v: FormValue) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      (v as readonly FormValue[]).forEach((item, i) => walk(`${key}[${i}]`, item));
      return;
    }
    if (typeof v === "object") {
      for (const [k, inner] of Object.entries(v as FormObject)) walk(`${key}[${k}]`, inner);
      return;
    }
    if (typeof v === "number" && !Number.isFinite(v)) throw new RangeError(`${key} is not a finite number`);
    out.push([key, String(v)]);
  };
  for (const [k, v] of Object.entries(params)) walk(prefix ? `${prefix}[${k}]` : k, v);
  return out;
}

/** The encoded body (brackets percent-encoded, which Stripe accepts). */
export function encodeForm(params: FormObject): string {
  return new URLSearchParams(formPairs(params)).toString();
}
