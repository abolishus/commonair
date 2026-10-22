// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One person using the real web app in a real browser: an isolated Playwright context (own
 * cookies) with the measurement probe injected into every page, helpers that select only by
 * `data-testid`, and screenshots of every open page for failure reports.
 */
import type { Logger } from "@commonair/observability";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import type { ProbeVideoStats } from "../../player/probe.ts";
import { type BrowserEngine, type BrowserFleet, HUMANIZE_SCRIPT } from "../browser-viewer.ts";
import { type TestId, tid } from "./selectors.ts";

export interface WebSessionOptions {
  fleet: BrowserFleet;
  engine: BrowserEngine;
  webUrl: string;
  /** Probe bundle (`playerBundles().probe`). */
  probeScript: string;
  /** Label used in logs and screenshot file names. */
  label: string;
  /** Remove automation tells so integrity treats this session as a person (default true). */
  humanize?: boolean;
  log?: Logger;
}

export class WebSession {
  private readonly pages = new Map<string, Page>();
  private closed = false;

  private constructor(
    readonly label: string,
    readonly engine: BrowserEngine,
    readonly context: BrowserContext,
    private readonly webUrl: string,
    private readonly log?: Logger,
  ) {}

  static async open(opts: WebSessionOptions): Promise<WebSession> {
    const browser = await opts.fleet.browser(opts.engine);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    try {
      await context.addInitScript({ content: opts.probeScript });
      if (opts.humanize !== false) await context.addInitScript({ content: HUMANIZE_SCRIPT });
    } catch (err) {
      await context.close().catch(() => undefined);
      throw err;
    }
    return new WebSession(opts.label, opts.engine, context, opts.webUrl, opts.log);
  }

  /** A named page in this session (created on first use). */
  async page(name = "main"): Promise<Page> {
    const existing = this.pages.get(name);
    if (existing && !existing.isClosed()) return existing;
    const page = await this.context.newPage();
    page.on("pageerror", (err) =>
      this.log?.warn("web page error", { session: this.label, page: name, error: err.message }),
    );
    this.pages.set(name, page);
    return page;
  }

  /** Navigate a page to a web app path (or absolute URL). */
  async goto(path: string, name = "main"): Promise<Page> {
    const page = await this.page(name);
    await page.goto(new URL(path, this.webUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForHydration(page);
    return page;
  }

  /**
   * Screenshot every open page into `dir`; returns the files written. Never throws. Elements
   * matching `redact` (CSS selectors, e.g. the stream key) are blanked first.
   */
  async screenshotAll(dir: string, redact: readonly string[] = []): Promise<string[]> {
    if (this.closed) return [];
    const written: string[] = [];
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return written;
    }
    for (const [name, page] of this.pages) {
      if (page.isClosed()) continue;
      if (redact.length > 0) {
        const redacted = await page
          .evaluate(
            (selectors) => {
              for (const el of document.querySelectorAll(selectors.join(","))) {
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = "[redacted]";
                else el.textContent = "[redacted]";
              }
            },
            [...redact],
          )
          .then(
            () => true,
            () => false,
          );
        // Never write a screenshot that might show a secret.
        if (!redacted) continue;
      }
      const file = join(dir, `${this.label}-${this.engine}-${name}.png`.replace(/[^a-z0-9._-]/gi, "_"));
      try {
        await page.screenshot({ path: file, fullPage: true, timeout: 10_000 });
        written.push(file);
      } catch (err) {
        this.log?.warn("screenshot failed", { session: this.label, page: name, error: (err as Error).message });
      }
    }
    return written;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
  }
}

/** Locator for a test id, optionally constrained by `data-*` attributes. */
export function byTestId(page: Page, id: TestId, data?: Record<string, string>): Locator {
  return page.locator(tid(id, data));
}

/** The text a person would read from a field: an input's value, otherwise the element's text. */
export async function readValue(locator: Locator, timeoutMs = 15_000): Promise<string> {
  await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
  const v = await locator
    .first()
    .evaluate((el) =>
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? ""),
    );
  return v.trim();
}

/** Probe snapshot of every `<video>` on the page. */
export async function probeStats(page: Page): Promise<ProbeVideoStats[]> {
  return page.evaluate(() => window.__harnessProbe?.snapshot() ?? []);
}

/** The web app sets `html[data-hydrated]` once React has hydrated (`routes/__root.tsx`). */
export const HYDRATED_SELECTOR = "html[data-hydrated]";

/**
 * Wait for hydration before interacting: React resets input typed before it, and buttons whose
 * state depends on it stay disabled. A web build without the marker only costs the timeout.
 */
export async function waitForHydration(page: Page, timeoutMs = 15_000): Promise<boolean> {
  try {
    await page.waitForSelector(HYDRATED_SELECTOR, { state: "attached", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}
