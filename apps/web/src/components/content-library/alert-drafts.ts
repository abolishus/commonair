// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/overlays` (d5-content, D5.4): the alert drafts behind the page's one save bar, pure for unit
 * tests. Which types changed, and what is wrong with a draft, under the contract's bounds.
 */
import {
  ALERT_DURATION_MAX_MS,
  ALERT_DURATION_MIN_MS,
  ALERT_MESSAGE_MAX,
  type AlertConfigDraft,
} from "@commonair/ui/blocks/studio";

export const sameAlertDraft = (a: AlertConfigDraft, b: AlertConfigDraft): boolean =>
  a.enabled === b.enabled &&
  a.message === b.message &&
  a.showMessage === b.showMessage &&
  a.minAmountCents === b.minAmountCents &&
  a.durationMs === b.durationMs &&
  a.animation === b.animation;

export interface AlertDraftEntry<T extends string> {
  type: T;
  saved: AlertConfigDraft;
  draft: AlertConfigDraft;
  /** The duration field's text, in seconds; the draft keeps the old value while it is unreadable. */
  durationText?: string;
  /** False while the amount field holds text it cannot read (it does not report a value then). */
  amountValid?: boolean;
}

/**
 * Whether a type has unsaved edits. Text the fields cannot read counts too: otherwise the save
 * bar would say everything is saved while a field shows its error.
 */
export const isAlertDirty = <T extends string>(e: AlertDraftEntry<T>): boolean =>
  !sameAlertDraft(e.saved, e.draft) ||
  e.amountValid === false ||
  (e.durationText !== undefined && e.durationText !== String(e.saved.durationMs / 1000));

/** The types with unsaved edits, in the order given. */
export function dirtyAlertTypes<T extends string>(entries: readonly AlertDraftEntry<T>[]): T[] {
  return entries.filter(isAlertDirty).map((e) => e.type);
}

export interface AlertDraftProblems {
  message: boolean;
  duration: boolean;
  amount: boolean;
  any: boolean;
}

/**
 * What blocks saving a draft: a blank or too-long message, a duration (as typed, in seconds)
 * outside 1 to 30 s, or (tips) an amount the field could not read or below zero.
 */
export function alertDraftProblems(
  draft: AlertConfigDraft,
  durationText: string,
  amountUnreadable = false,
): AlertDraftProblems {
  const message = draft.message.trim() === "" || draft.message.length > ALERT_MESSAGE_MAX;
  const seconds = Number(durationText);
  const duration =
    durationText.trim() === "" ||
    !Number.isFinite(seconds) ||
    seconds * 1000 < ALERT_DURATION_MIN_MS ||
    seconds * 1000 > ALERT_DURATION_MAX_MS;
  const amount = amountUnreadable || draft.minAmountCents < 0;
  return { message, duration, amount, any: message || duration || amount };
}
