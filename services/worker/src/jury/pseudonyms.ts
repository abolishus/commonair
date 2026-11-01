// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-panel pseudonyms (ADR 0038 §5): a juror sees the same name for the same person across the
 * panel's cases, and different names on another panel. Each panel gets a fresh random salt that
 * is used once and never stored (only the resulting `pseudonym_map` is), so neither the revealed
 * draw seed nor public user ids can unmask a pseudonym later.
 */
import { pseudonym } from "@commonair/draw";

/** Hex characters of the HMAC a pseudonym keeps (upper-cased for reading). */
export const PSEUDONYM_LENGTH = 8;
/** `pseudonym_map` key of the case's primary subject. */
export const SUBJECT_KEY = "subject";

/** A pseudonym for every id, from one salt: deterministic in (salt, id). */
export async function panelPseudonyms(salt: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(ids)) {
    out.set(id, (await pseudonym(salt, id)).slice(0, PSEUDONYM_LENGTH).toUpperCase());
  }
  return out;
}

/**
 * One case's `pseudonym_map`: `subject` → the primary subject's pseudonym, plus each named
 * party's. Reporters are never in it (they are never shown).
 */
export function caseMap(
  names: ReadonlyMap<string, string>,
  subjectId: string,
  partyIds: readonly string[],
): Record<string, string> {
  const map: Record<string, string> = {};
  const subject = names.get(subjectId);
  if (subject !== undefined) map[SUBJECT_KEY] = subject;
  for (const id of partyIds) {
    const n = names.get(id);
    if (n !== undefined) map[id] = n;
  }
  return map;
}
