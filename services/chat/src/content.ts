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

/** Compile filters once per channel load; invalid regexes are skipped (and reported). */
export function compileFilters(
  defs: readonly WordFilterDef[],
  onInvalid: (def: WordFilterDef) => void = () => {},
): CompiledFilter[] {
  const out: CompiledFilter[] = [];
  for (const def of defs) {
    const source = def.isRegex ? def.pattern : escapeRegex(def.pattern);
    try {
      out.push({ def, re: new RegExp(source, "giu") });
    } catch {
      try {
        out.push({ def, re: new RegExp(source, "gi") });
      } catch {
        onInvalid(def);
      }
    }
  }
  return out;
}

export type FilterOutcome =
  | { action: "block"; filterId: string }
  | { action: "hold" | "pass"; body: string; filterId: string | null };

const matches = (re: RegExp, body: string): boolean => {
  re.lastIndex = 0;
  const hit = re.test(body);
  re.lastIndex = 0;
  return hit;
};

/** Block beats hold beats replace; replacements are applied in either non-block case. */
export function applyFilters(body: string, filters: readonly CompiledFilter[]): FilterOutcome {
  const block = filters.find((f) => f.def.action === "block" && matches(f.re, body));
  if (block) return { action: "block", filterId: block.def.id };
  let out = body;
  for (const f of filters) {
    if (f.def.action !== "replace") continue;
    f.re.lastIndex = 0;
    out = out.replace(f.re, (m) => f.def.replacement ?? m.replace(/./gsu, "*"));
  }
  const hold = filters.find((f) => f.def.action === "hold" && matches(f.re, body));
  if (hold) return { action: "hold", body: out, filterId: hold.def.id };
  return { action: "pass", body: out, filterId: null };
}
