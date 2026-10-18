// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ISO 4217 minor units, explicit so every engine (V8, JSC, Bun, browsers) and every component
 * (UI formatting, ledger, payment adapters) agrees. `Intl` disagrees across engines for several
 * currencies (e.g. HUF, IDR, IQD), so never derive minor units from it.
 * Currencies not listed use 2.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  bhd: 3,
  bif: 0,
  clf: 4,
  clp: 0,
  djf: 0,
  gnf: 0,
  iqd: 3,
  isk: 0,
  jod: 3,
  jpy: 0,
  kmf: 0,
  krw: 0,
  kwd: 3,
  lyd: 3,
  omr: 3,
  pyg: 0,
  rwf: 0,
  tnd: 3,
  ugx: 0,
  uyi: 0,
  uyw: 4,
  vnd: 0,
  vuv: 0,
  xaf: 0,
  xof: 0,
  xpf: 0,
};

export function minorUnits(currency: string): number {
  return CURRENCY_MINOR_UNITS[currency.toLowerCase()] ?? 2;
}
