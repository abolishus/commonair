// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Locale negotiation (ADR 0029 decision 3) and text direction. */

const TAG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;
const QUALITY = /^q=(0(\.\d{0,3})?|1(\.0{0,3})?)$/i;
const MAX_TAGS = 20;
// A real header is a few dozen bytes; cap the work a hostile one can cause.
const MAX_HEADER = 4096;

/** Accept-Language → tags by descending q (stable), `*` and q=0 dropped, at most 20, malformed parts skipped. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const parsed: { tag: string; q: number; i: number }[] = [];
  const parts = header.slice(0, MAX_HEADER).split(",");
  for (const [i, part] of parts.entries()) {
    const [rawTag, ...params] = part.split(";").map((s) => s.trim());
    if (!rawTag || rawTag === "*" || !TAG.test(rawTag)) continue;
    let q = 1;
    let malformed = false;
    for (const param of params) {
      const m = QUALITY.exec(param);
      if (!m) {
        malformed = true;
        break;
      }
      q = Number(param.slice(2));
    }
    if (malformed || q <= 0) continue;
    parsed.push({ tag: rawTag, q, i });
  }
  parsed.sort((a, b) => b.q - a.q || a.i - b.i);
  return parsed.slice(0, MAX_TAGS).map((p) => p.tag);
}

/** First candidate that matches `supported`: exact tag (case-insensitive), then its language subtag. */
export function negotiateLocale(candidates: readonly string[], supported: readonly string[]): string | undefined {
  const byLower = new Map(supported.map((tag) => [tag.toLowerCase(), tag]));
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const exact = byLower.get(lower);
    if (exact) return exact;
    const language = lower.split("-")[0];
    // Only a bare language tag can be reached by fallback, so `en-GB` finds `en`, never `en-XA`.
    const fallback = language === undefined || language === lower ? undefined : byLower.get(language);
    if (fallback) return fallback;
  }
  return undefined;
}

/** ADR 0029 order: user choice, stored choice, Accept-Language, instance default, then `en`. */
export function pickLocale(input: {
  userLocale?: string | null;
  stored?: string | null;
  acceptLanguage?: string | null;
  instanceDefault: string;
  supported: readonly string[];
}): string {
  const { supported } = input;
  const one = (tag: string | null | undefined) => (tag ? negotiateLocale([tag], supported) : undefined);
  return (
    one(input.userLocale) ??
    one(input.stored) ??
    negotiateLocale(parseAcceptLanguage(input.acceptLanguage), supported) ??
    one(input.instanceDefault) ??
    "en"
  );
}

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "ps", "yi", "dv", "ckb", "sd", "ug"]);
const RTL_SCRIPTS = new Set(["arab", "hebr", "thaa", "syrc", "nkoo", "adlm"]);

export function localeDirection(tag: string): "ltr" | "rtl" {
  const [language = "", ...rest] = tag.toLowerCase().split("-");
  // A script subtag decides when present (`pa-Arab` is rtl, `uz-Latn` is not).
  const script = rest.find((part) => part.length === 4 && /^[a-z]+$/.test(part));
  if (script) return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
  return RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}
