// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Money helpers for the page stories. Fixtures store integer cents and a currency; the stories
 * render them only through `MoneyAmount` / `formatMoney`. Sub-cent unit costs (e.g. $0.0061 per
 * viewer-hour) are integer micro-units rendered with `formatUnitCost`.
 */
import type * as React from "react";
import { MoneyAmount, formatMoney } from "@commonair/ui";
import { formatUnitCost } from "../../src/lib/format.ts";

export const CURRENCY = "USD";
export const LOCALE = "en-US";

/** An amount in integer minor units; `signed` shows "+" on positive amounts. */
export interface Money {
  cents: number;
  signed?: boolean;
}

/** A sub-cent unit cost in integer micro-units (millionths of a dollar). */
export interface UnitCost {
  micros: number;
}

export type Figure = Money | UnitCost;

/** Text with an optional amount inside it, e.g. "+$1,140 vs same days in Sep". */
export interface MoneyNote {
  before?: string;
  money: Money;
  after?: string;
}

export function moneyText({ cents, signed }: Money): string {
  return formatMoney(cents, CURRENCY, LOCALE, signed ? { signDisplay: "exceptZero" } : {});
}

export function unitCostText({ micros }: UnitCost): string {
  return formatUnitCost(micros, CURRENCY, LOCALE);
}

export function Amount({ value }: { value: Money }): React.JSX.Element {
  return (
    <MoneyAmount
      value={{ cents: value.cents, currency: CURRENCY }}
      locale={LOCALE}
      signDisplay={value.signed ? "exceptZero" : undefined}
    />
  );
}

export function FigureValue({ value }: { value: Figure }): React.JSX.Element {
  return "micros" in value ? <span className="tabular-nums">{unitCostText(value)}</span> : <Amount value={value} />;
}

export function noteText(note: string | MoneyNote): string {
  return typeof note === "string" ? note : `${note.before ?? ""}${moneyText(note.money)}${note.after ?? ""}`;
}
