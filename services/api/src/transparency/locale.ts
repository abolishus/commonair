// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The language a public report's clause titles come in (ADR 0029 order): the signed-in user's
 * choice, the web's language cookie, then Accept-Language; English when none has a catalog. The
 * titles live in the email catalog (`enforcementStatement.clause.*`), which every service shares.
 */
import { BUNDLED } from "@commonair/email";

/** The web's language cookie (`apps/web/src/i18n/cookie.ts`). */
const LOCALE_COOKIE = "commonair-locale";
const TAG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;
const MAX_HEADER = 4096;

/** The bundled catalog a tag reaches (exact, then its language), or undefined. */
function supported(tag: string | null | undefined): string | undefined {
  if (!tag || !TAG.test(tag)) return undefined;
  if (Object.hasOwn(BUNDLED, tag)) return tag;
  const language = tag.split("-")[0]?.toLowerCase();
  return language && Object.hasOwn(BUNDLED, language) ? language : undefined;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.slice(0, MAX_HEADER).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Accept-Language tags by descending q (stable); `*`, q=0 and malformed parts dropped. */
export function acceptLanguageTags(header: string | null): string[] {
  if (!header) return [];
  const tags: { tag: string; q: number; i: number }[] = [];
  for (const [i, part] of header.slice(0, MAX_HEADER).split(",").entries()) {
    const [tag = "", ...params] = part.split(";").map((p) => p.trim());
    if (!TAG.test(tag)) continue;
    const qParam = params.find((p) => p.toLowerCase().startsWith("q="));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    if (!Number.isFinite(q) || q <= 0 || q > 1) continue;
    tags.push({ tag, q, i });
  }
  return tags.sort((a, b) => b.q - a.q || a.i - b.i).map((t) => t.tag);
}

export function requestLocale(input: { userLocale: string | null; headers: Headers }): string {
  return (
    supported(input.userLocale) ??
    supported(cookieValue(input.headers.get("cookie"), LOCALE_COOKIE)) ??
    acceptLanguageTags(input.headers.get("accept-language"))
      .map(supported)
      .find((t) => t !== undefined) ??
    "en"
  );
}
