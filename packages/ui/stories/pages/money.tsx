// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Money helpers for the page stories. Fixtures store integer cents and a currency; the stories
 * render them only through `MoneyAmount` / `formatMoney`. Sub-cent unit costs (e.g. $0.0061 per
 * viewer-hour) cannot be cents, so fixtures carry those as strings (`SubCent`) until `formatMoney`
 * has a sub-minor-unit precision option (contract request).
 */
import type * as React from "react";
import { MoneyAmount, formatMoney } from "@commonair/ui";

export const CURRENCY = "USD";
export const LOCALE = "en-US";

/** An amount in integer minor units; `signed` shows "+" on positive amounts. */
export interface Money {
  cents: number;
  signed?: boolean;
}

/** A sub-cent unit cost, pre-formatted because it cannot be expressed in integer cents. */
export interface SubCent {
  subCent: string;
}

export type Figure = Money | SubCent;

/** Text with an optional amount inside it, e.g. "+$1,140 vs same days in Sep". */
export interface MoneyNote {
  before?: string;
  money: Money;
  after?: string;
}

export function moneyText({ cents, signed }: Money): string {
  return formatMoney(cents, CURRENCY, LOCALE, signed ? { signDisplay: "exceptZero" } : {});
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
  return "subCent" in value ? <>{value.subCent}</> : <Amount value={value} />;
}

export function noteText(note: string | MoneyNote): string {
  return typeof note === "string" ? note : `${note.before ?? ""}${moneyText(note.money)}${note.after ?? ""}`;
}
