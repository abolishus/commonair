// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The words of a load failure (F3, voice-copy 4.10), in one place: "{section} didn't load." plus
 * what happens next, and Retry (Retry now while an automatic retry is scheduled).
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
  return t("fixSession.load.title", { section });
}

/** The heading when the whole page did not load (an error boundary's busy page). */
export function loadErrorPageTitle(): string {
  return t("fixSession.load.pageTitle");
}

/** `seconds`: the wait before the scheduled retry, when one is known (for the "busy" note). */
export function loadErrorNote(note: LoadNote, seconds?: number): string {
  switch (note) {
    case "section":
      return t("fixSession.load.sectionBody");
    case "page":
      return t("fixSession.load.pageBody");
    case "busy":
      // No known wait: only the session recovery retries that way, so say what it is doing.
      return seconds === undefined ? t("fixSession.session.checking") : t("fixSession.load.busy", { seconds });
    case "stillFailing":
      return t("fixSession.load.stillFailing");
  }
}

/** The button: `waiting` while an automatic retry is scheduled. */
export function loadRetryLabel(waiting: boolean): string {
  return waiting ? t("fixSession.retryNow") : t("fixSession.retry");
}
