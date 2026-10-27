// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure DMCA rules (17 U.S.C. § 512, as summarised in docs/operators/dmca.md). NOT REVIEWED BY A
 * LAWYER: the flow, the constants in `DMCA_RULES` and these functions are an engineering reading
 * of the statute, nothing more.
 */
import { DMCA_RULES } from "@commonair/contracts/enums";

const DAY_MS = 86_400_000;

/**
 * `start` plus `n` weekdays (Monday to Friday, UTC), keeping the time of day. A start on a
 * weekend counts from the following Monday. Public holidays are NOT modelled: that is why
 * `DMCA_RULES.restoreWeekdays` is 12, which stays inside the statute's 10 to 14 business days even
 * with two federal holidays in the window. UTC has no daylight saving time, so DST never moves it.
 */
export function addWeekdays(start: Date, n: number): Date {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("addWeekdays: n must be a non-negative integer");
  let t = start.getTime();
  let added = 0;
  while (added < n) {
    t += DAY_MS;
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return new Date(t);
}

/** When countered content comes back (§ 512(g)(2)(C)): receipt + `DMCA_RULES.restoreWeekdays` weekdays. */
export const restoreAfter = (receivedAt: Date): Date => addWeekdays(receivedAt, DMCA_RULES.restoreWeekdays);

/** Weekdays strictly after `from` up to and including `to` (UTC); tests and docs use it to check the window. */
export function weekdaysBetween(from: Date, to: Date): number {
  let n = 0;
  for (let t = from.getTime() + DAY_MS; t <= to.getTime(); t += DAY_MS) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

/**
 * One canonical spelling per URL, so the same location listed twice yields one item: host
 * lowercased (URL does it), fragment dropped, a trailing `/` dropped from a non-root path,
 * surrounding whitespace trimmed. Something that is not a URL is kept as typed (trimmed).
 */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  try {
    const u = new URL(s);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return s;
  }
}

/** Normalised, de-duplicated URLs in their first-seen order; blanks dropped. */
export function dedupeUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (raw.trim() === "") continue;
    const u = normalizeUrl(raw);
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

export type RepeatInfringerOutcome = "none" | "notify" | "terminate";

/**
 * What the repeat-infringer policy (§ 512(i)(1)(A)) does after a strike, given the user's
 * unreversed strikes in the window (this one included). At or over a positive threshold with no
 * termination in force: terminate (suspend, notify moderators). A threshold of 0 turns the
 * automatic suspension off: every strike only notifies moderators, who decide by hand.
 */
export function repeatInfringerOutcome(
  strikes: number,
  hasActiveTermination: boolean,
  threshold: number = DMCA_RULES.repeatInfringerStrikes,
): RepeatInfringerOutcome {
  if (strikes <= 0) return "none";
  if (threshold <= 0) return "notify";
  if (strikes < threshold || hasActiveTermination) return "none";
  return "terminate";
}

/** Whether a strike count marks a repeat infringer in the staff view (`dmcaq-strikes`). */
export const isRepeatInfringer = (strikes: number, threshold: number = DMCA_RULES.repeatInfringerStrikes) =>
  threshold > 0 && strikes >= threshold;
