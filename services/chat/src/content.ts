// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Content rules: link detection and channel word filters. */
import { unsafeFilterRegexReason } from "@commonair/safe-regex";
import type { WordFilterDef } from "./types.ts";

/**
 * Explicit schemes, `www.` hosts, and bare `host.tld` forms (TLD of 2+ letters). Deliberately
 * broad: a channel that disables links prefers a false positive over a phishing link.
 */
const LINK =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/\S+)|(?:\bwww\.\S+)|(?:\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.[a-z]{2,24}(?::\d{1,5})?(?:\/\S*)?(?=$|[\s,;!?)'"]|\.(?:\s|$)))/iu;

export const containsLink = (body: string): boolean => LINK.test(body);

export interface CompiledFilter {
  def: WordFilterDef;
  re: RegExp;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile filters once per channel load. Regex patterns are re-validated with the same checker
 * the API uses on save, so patterns stored before a stricter rule shipped are skipped (and
 * reported) rather than run. Literal patterns are escaped and always linear.
 */
export function compileFilters(
  defs: readonly WordFilterDef[],
  onInvalid: (def: WordFilterDef, reason: string) => void = () => {},
): CompiledFilter[] {
  const out: CompiledFilter[] = [];
  for (const def of defs) {
    const unsafe = def.isRegex ? unsafeFilterRegexReason(def.pattern) : null;
    if (unsafe) {
      onInvalid(def, unsafe);
      continue;
    }
    try {
      out.push({ def, re: new RegExp(def.isRegex ? def.pattern : escapeRegex(def.pattern), "giu") });
    } catch {
      onInvalid(def, "invalid regular expression");
    }
  }
  return out;
}

export type FilterOutcome =
  | { action: "block"; filterId: string }
  | { action: "hold" | "pass"; body: string; filterId: string | null; timedOut?: boolean };

/** Total time all filters may spend on one message before it is held for review instead. */
export const FILTER_BUDGET_MS = 25;

/**
 * Block beats hold beats replace; replacements are applied in either non-block case. If the
 * filters run past `budgetMs` the remaining ones are skipped and the message is held, so a slow
 * pattern can neither stall chat nor let a message bypass the filters.
 */
export function applyFilters(
  body: string,
  filters: readonly CompiledFilter[],
  budgetMs = FILTER_BUDGET_MS,
  clock: () => number = () => performance.now(),
): FilterOutcome {
  const started = clock();
  const over = () => clock() - started > budgetMs;
  const timedOut = (out: string): FilterOutcome => ({ action: "hold", body: out, filterId: null, timedOut: true });
  const matches = (re: RegExp, text: string): boolean => {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    return hit;
  };
  for (const f of filters) {
    if (f.def.action !== "block") continue;
    if (over()) return timedOut(body);
    if (matches(f.re, body)) return { action: "block", filterId: f.def.id };
  }
  let out = body;
  for (const f of filters) {
    if (f.def.action !== "replace") continue;
    if (over()) return timedOut(out);
    f.re.lastIndex = 0;
    out = out.replace(f.re, (m) => f.def.replacement ?? m.replace(/./gsu, "*"));
  }
  for (const f of filters) {
    if (f.def.action !== "hold") continue;
    if (over()) return timedOut(out);
    if (matches(f.re, body)) return { action: "hold", body: out, filterId: f.def.id };
  }
  if (over()) return timedOut(out);
  return { action: "pass", body: out, filterId: null };
}
