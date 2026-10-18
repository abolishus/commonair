// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Content rules: link detection and channel word filters. */
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

const MAX_REPEAT = 1000;

/**
 * Reject regex shapes that can backtrack catastrophically: backreferences, and a quantified
 * group that itself contains a quantifier or an alternation (`(a+)+`, `(a|aa)*`, `(\w?)+`).
 * Returns the reason, or null when the pattern is safe to run. Linear-ish patterns that slip
 * through are still bounded by the per-message time budget in `applyFilters`.
 */
export function unsafeRegexReason(pattern: string): string | null {
  type Frame = { quantified: boolean; alternation: boolean };
  const stack: Frame[] = [{ quantified: false, alternation: false }];
  const top = () => stack[stack.length - 1] ?? { quantified: false, alternation: false };
  /** Length of the quantifier at `i` (0 if none) and whether it repeats more than once. */
  const quantifierAt = (i: number): { len: number; repeats: boolean; tooBig: boolean } => {
    const c = pattern[i];
    let len = 0;
    let repeats = false;
    let tooBig = false;
    if (c === "*" || c === "+") [len, repeats] = [1, true];
    else if (c === "?") len = 1;
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m) {
        len = m[0].length;
        const max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
        repeats = max > 1;
        tooBig = Number(m[1]) > MAX_REPEAT || (Number.isFinite(max) && max > MAX_REPEAT);
      }
    }
    // A trailing "?" makes the quantifier lazy; it does not change the shape.
    if (len > 0 && pattern[i + len] === "?") len++;
    return { len, repeats, tooBig };
  };
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (/[1-9]/.test(next) || next === "k") return "backreferences are not allowed";
      i += 2;
    } else if (c === "[") {
      i++;
      while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "(") {
      stack.push({ quantified: false, alternation: false });
      i++;
      continue;
    } else if (c === ")") {
      const frame = stack.pop();
      if (!frame || stack.length === 0) return "unbalanced parentheses";
      const q = quantifierAt(i + 1);
      if (q.tooBig) return `repetition counts above ${MAX_REPEAT} are not allowed`;
      if (q.repeats && (frame.quantified || frame.alternation))
        return "nested quantifiers or quantified alternations are not allowed";
      top().quantified ||= frame.quantified || q.len > 0;
      i += 1 + q.len;
      continue;
    } else if (c === "|") {
      top().alternation = true;
      i++;
      continue;
    } else i++;
    // After an atom: an optional quantifier.
    const q = quantifierAt(i);
    if (q.tooBig) return `repetition counts above ${MAX_REPEAT} are not allowed`;
    if (q.len > 0) top().quantified = true;
    i += q.len;
  }
  return stack.length === 1 ? null : "unbalanced parentheses";
}

/** Compile filters once per channel load; invalid or unsafe regexes are skipped (and reported). */
export function compileFilters(
  defs: readonly WordFilterDef[],
  onInvalid: (def: WordFilterDef, reason: string) => void = () => {},
): CompiledFilter[] {
  const out: CompiledFilter[] = [];
  for (const def of defs) {
    const unsafe = def.isRegex ? unsafeRegexReason(def.pattern) : null;
    if (unsafe) {
      onInvalid(def, unsafe);
      continue;
    }
    const source = def.isRegex ? def.pattern : escapeRegex(def.pattern);
    try {
      out.push({ def, re: new RegExp(source, "giu") });
    } catch {
      try {
        out.push({ def, re: new RegExp(source, "gi") });
      } catch {
        onInvalid(def, "invalid regular expression");
      }
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
