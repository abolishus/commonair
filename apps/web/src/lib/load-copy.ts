// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The words of a load failure (F3), in one place. For now they come from keys the catalogs
 * already have: the section's own heading names what did not load, and the note says to try
 * again. The voice-copy wording ("{section} didn't load.", "Retrying in N seconds…", "Retry now")
 * waits for its catalog keys; when they land, only this file changes.
 */
import { t } from "../i18n/index.ts";

/** What the note under the heading says. */
export type LoadNote =
  /** Other sections of the page loaded. */
  | "section"
  /** Nothing on the page loaded. */
  | "page"
  /** An automatic retry is scheduled in `seconds`. */
  | "busy"
  /** The automatic retries ran out. */
  | "stillFailing";

/** The heading: the section's own name, already translated ("Open proposals"). */
export function loadErrorTitle(section: string): string {
  return section;
}

/** The heading when the whole page did not load (an error boundary's busy page). */
export function loadErrorPageTitle(): string {
  return t("coop.loadFailedTitle");
}

/** `seconds`: the wait before the scheduled retry, when one is known (for the "busy" note). */
export function loadErrorNote(note: LoadNote, _seconds?: number): string {
  switch (note) {
    case "page":
    case "stillFailing":
      return t("refundRequests.retryHint");
    case "section":
    case "busy":
      return t("coop.loadFailed");
  }
}

/** The button: `waiting` while an automatic retry is scheduled. */
export function loadRetryLabel(_waiting: boolean): string {
  return t("polish.error.retry");
}
