// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e2e-basic --set locale=<tag>` (batch 5 decision (k)): every browser session gets the
 * `commonair-locale` cookie; under `en-XA` each page the scenario visits is scanned for
 * untranslated text, and a cheap `es` smoke step checks negotiation from `Accept-Language`.
 */
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { PSEUDO_LOCALE, pseudoLocalize } from "../../../packages/i18n/src/pseudo.ts";
import type { ScenarioContext } from "../scenario.ts";
import { TEST_IDS as T } from "../web/selectors.ts";
import { type LiteralHit, scanPage } from "./literals.ts";

export { PSEUDO_LOCALE };
/** Hits kept in a check's details; the full list goes to `ctx.data`. */
const DETAIL_HITS = 20;

/** The `locale` parameter, canonicalized; undefined when not set (today's behaviour). */
export function localeParam(ctx: Pick<ScenarioContext, "param">): string | undefined {
  const raw = ctx.param("locale", "").trim();
  if (!raw) return undefined;
  const [tag] = Intl.getCanonicalLocales(raw);
  if (!tag) throw new Error(`--set locale=${raw}: not a BCP 47 tag`);
  return tag;
}

/** Every string in a JSON-like value (API data the page may show), deduplicated. */
export function stringsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    if (value.trim()) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringsIn(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) stringsIn(v, out);
  }
  return out;
}

/** The channel fields a page shows as channel data (not ids, theme presets or language codes). */
export interface ChannelText {
  slug: string;
  displayName: string;
  title: string;
  description: string;
  category: { name: string } | null;
  tags: readonly string[];
  owner: { username: string; displayName: string };
  live: { title: string; category: { name: string } | null } | null;
  panels: readonly { title: string; body: string; linkUrl: string | null }[];
  subTiers: readonly { name: string; benefits: string }[];
}

export function channelUserContent(c: ChannelText): string[] {
  return [
    ...stringsIn([c.slug, c.displayName, c.title, c.description, c.category?.name, c.tags]),
    ...stringsIn([c.owner.username, c.owner.displayName, c.live?.title, c.live?.category?.name]),
    ...stringsIn(c.panels.map((p) => [p.title, p.body, p.linkUrl])),
    ...stringsIn(c.subTiers.map((t) => [t.name, t.benefits])),
  ];
}

/** The step name the brief fixes for one scan. */
export function scanStepName(who: string, page: string): string {
  return `${who}: no untranslated text on ${page}`;
}

/** A report key for one scan's hits. */
export function hitsDataKey(who: string, page: string): string {
  return `untranslated.${who}.${page}`.replace(/[^a-z0-9.]+/gi, "_");
}

/**
 * Scans pages under `en-XA`; a no-op for any other locale. Hits fail a soft check (the run goes
 * on to scan the other pages) with the hits attached to the report.
 */
export class LiteralScanner {
  private readonly content = new Set<string>();
  private pagesScanned = 0;
  private hitsTotal = 0;

  constructor(
    private readonly ctx: ScenarioContext,
    private readonly check: ScenarioContext["check"],
    readonly enabled: boolean,
  ) {}

  private readonly secrets = new Set<string>();

  /** Values the scenario created or read: never flagged. */
  userContent(...values: unknown[]): void {
    for (const v of values) stringsIn(v, this.content);
  }

  /** User content that must also never reach the report (the stream key). */
  secret(value: string): void {
    this.userContent(value);
    if (value.trim()) this.secrets.add(value);
  }

  async scan(who: string, pageName: string, page: Page): Promise<void> {
    if (!this.enabled) return;
    const name = scanStepName(who, pageName);
    const { hits, scanned } = await this.ctx.step(name, () => scanPage(page, { userContent: this.content }));
    this.pagesScanned++;
    this.hitsTotal += hits.length;
    if (hits.length > 0) this.ctx.data(hitsDataKey(who, pageName), redactHits(hits, this.secrets));
    this.check(name, hits.length === 0, summarizeHits(hits, scanned));
  }

  /** Writes the page count (and total hits) to the report. */
  report(): void {
    if (!this.enabled) return;
    this.ctx.data("literalScan", { pages: this.pagesScanned, hits: this.hitsTotal });
  }
}

/** Hits with every secret blanked out of their text. */
export function redactHits(hits: readonly LiteralHit[], secrets: Iterable<string>): LiteralHit[] {
  const list = [...secrets].filter((s) => s.length > 0);
  return hits.map((h) => ({ ...h, text: list.reduce((t, s) => t.replaceAll(s, "[redacted]"), h.text) }));
}

function summarizeHits(hits: readonly LiteralHit[], scanned: number) {
  return {
    scanned,
    hits: hits.length,
    first: hits.slice(0, DETAIL_HITS).map((h) => ({ words: h.words, kind: h.kind, selector: h.selector })),
  };
}

/** One message from a web catalog JSON (`apps/web/src/i18n/locales/<lang>/<namespace>.json`). */
export function webCatalogMessage(lang: string, namespace: string, key: string): string {
  const url = new URL(`../../../apps/web/src/i18n/locales/${lang}/${namespace}.json`, import.meta.url);
  const catalog = JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
  const message = catalog[key];
  if (typeof message !== "string") throw new Error(`${lang}/${namespace}.json has no "${key}"`);
  return message;
}

/** What the page says its language is, and the footer's plain text spans. */
export interface PageLanguage {
  lang: string | null;
  dir: string | null;
  footerTexts: string[];
}

/** `<html lang dir>` and the texts of the footer that holds the AGPL source link. */
export async function readPageLanguage(page: Page, timeoutMs: number): Promise<PageLanguage> {
  const html = await page.evaluate(() => ({
    lang: document.documentElement.getAttribute("lang"),
    dir: document.documentElement.getAttribute("dir"),
  }));
  // The license line has no test id: reach it from the footer's `footer-source-link`.
  const footer = page.locator(`[data-testid="${T.footerSourceLink}"]`).first().locator("xpath=ancestor::footer[1]");
  await footer.waitFor({ state: "attached", timeout: timeoutMs });
  const footerTexts = await footer
    .locator("span")
    .evaluateAll((els) => els.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()));
  return { ...html, footerTexts };
}

/** The license line every locale's footer must show, from the catalogs (pseudo for `en-XA`). */
export function expectedFooterLicense(locale: string): string {
  return locale === PSEUDO_LOCALE
    ? pseudoLocalize(webCatalogMessage("en", "core", "footer.license"))
    : webCatalogMessage(locale, "core", "footer.license");
}
