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
import type { BrowserContext, Locator, Page, Request, Response } from "playwright";
import type { ProbeVideoStats } from "../../player/probe.ts";
import { type BrowserEngine, type BrowserFleet, HUMANIZE_SCRIPT } from "../browser-viewer.ts";
import { PendingCalls, apiPath } from "./api-calls.ts";
import { documentScriptOrder, isHydrationBootError, readBootState } from "./hydration.ts";
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
  /**
   * The language this person asks for. A string (or `cookie`) sets the web app's
   * `commonair-locale` cookie for the web origin only; `acceptLanguage` makes the browser send
   * that `Accept-Language` (and report it as `navigator.language`). Absent: today's `en-US`.
   */
  locale?: string | WebSessionLocale;
  /**
   * This person's simulated client address (`simulateClientAddress`). Absent: the fleet's next
   * (`BrowserFleet.nextAddress`); null: none, so the API sees the runner's own address.
   */
  clientIp?: string | null;
}

/**
 * The headers for a request to the web origin from a session at `clientIp`: its own, with
 * `x-forwarded-for` set to that address (any spelling the page sent replaced). Pure.
 */
export function withSimulatedAddress(headers: Record<string, string>, clientIp: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== "x-forwarded-for") out[k] = v;
  out["x-forwarded-for"] = clientIp;
  return out;
}

/**
 * Give every request this context sends to the web origin `x-forwarded-for: <clientIp>`, as the
 * harness forwarding proxy does for API clients (harness/src/proxy.ts). The web server appends
 * the address it accepted the connection from, and the API walks the chain right to left past
 * the hops in TRUSTED_PROXY_CIDRS (the harness stack trusts its compose network, the host side of
 * a published port included), so each browser session is its own client: its own `auth` and
 * `default` rate-limit subjects, rather than one shared by every browser of a shard. Other origins
 * (HLS, object storage) are left alone: a header their CORS rules never allowed would fail the
 * preflight. A context route, not `extraHTTPHeaders`, for exactly that reason.
 */
export async function simulateClientAddress(context: BrowserContext, webUrl: string, clientIp: string): Promise<void> {
  const origin = new URL(webUrl).origin;
  await context.route(
    (url) => url.origin === origin,
    async (route) => {
      // The Cookie header stays the browser's own (Playwright never overrides it here).
      await route.fallback({ headers: withSimulatedAddress(route.request().headers(), clientIp) }).catch(() => {
        // The page or context closed while the request was paused: nothing left to send it.
      });
    },
  );
}

export interface WebSessionLocale {
  cookie?: string;
  acceptLanguage?: string;
}

/** The web app's locale cookie (`apps/web/src/i18n/cookie.ts` `LOCALE_COOKIE`). */
export const WEB_LOCALE_COOKIE = "commonair-locale";
const DEFAULT_BROWSER_LOCALE = "en-US";

/** The cookie Playwright should add for `locale`, host-only on the web host; null for none. */
export function localeCookie(
  webUrl: string,
  locale: WebSessionOptions["locale"],
): { name: string; value: string; url: string; sameSite: "Lax" } | null {
  const tag = typeof locale === "string" ? locale : locale?.cookie;
  if (!tag) return null;
  // `url` (not `domain`) makes it host-only on the web host. Cookies ignore ports, so an API on
  // the same host (localhost:3001 in `.env.example`) receives it too; nothing there reads it.
  return { name: WEB_LOCALE_COOKIE, value: encodeURIComponent(tag), url: new URL(webUrl).origin, sameSite: "Lax" };
}

/** The browser locale (`Accept-Language`, `navigator.language`) for `locale`. */
export function browserLocale(locale: WebSessionOptions["locale"]): string {
  return (typeof locale === "object" && locale.acceptLanguage) || DEFAULT_BROWSER_LOCALE;
}

/** An API call unanswered this long when a failure screenshot is taken is reported as pending. */
const PENDING_REPORT_MS = 5_000;

export class WebSession {
  private readonly pages = new Map<string, Page>();
  private readonly pending = new Map<string, PendingCalls<Request>>();
  private closed = false;

  private constructor(
    readonly label: string,
    readonly engine: BrowserEngine,
    readonly context: BrowserContext,
    private readonly webUrl: string,
    /** The simulated client address the web app and the API see for this session, if any. */
    readonly clientIp: string | null,
    private readonly log?: Logger,
  ) {}

  static async open(opts: WebSessionOptions): Promise<WebSession> {
    const browser = await opts.fleet.browser(opts.engine);
    const clientIp = opts.clientIp === undefined ? opts.fleet.nextAddress() : opts.clientIp;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: browserLocale(opts.locale),
    });
    try {
      if (clientIp) await simulateClientAddress(context, opts.webUrl, clientIp);
      const cookie = localeCookie(opts.webUrl, opts.locale);
      if (cookie) await context.addCookies([cookie]);
      await context.addInitScript({ content: opts.probeScript });
      if (opts.humanize !== false) await context.addInitScript({ content: HUMANIZE_SCRIPT });
    } catch (err) {
      await context.close().catch(() => undefined);
      throw err;
    }
    return new WebSession(opts.label, opts.engine, context, opts.webUrl, clientIp, opts.log);
  }

  /** A named page in this session (created on first use). */
  async page(name = "main"): Promise<Page> {
    const existing = this.pages.get(name);
    if (existing && !existing.isClosed()) return existing;
    const page = await this.context.newPage();
    page.on("pageerror", (err) =>
      this.log?.warn("web page error", { session: this.label, page: name, error: err.message }),
    );
    this.trackHydration(page, name);
    this.trackApiCalls(page, name);
    this.pages.set(name, page);
    return page;
  }

  /**
   * Log the API calls a page gets an error for (status >= 400), or none at all (network
   * failure), and remember the unanswered ones for `screenshotAll`: a page waiting on data it
   * never gets otherwise shows up only as a selector timeout.
   */
  private trackApiCalls(page: Page, name: string): void {
    const pending = new PendingCalls<Request>();
    this.pending.set(name, pending);
    const fields = { session: this.label, page: name };
    page.on("request", (req) => {
      const path = apiPath(req.url(), this.webUrl);
      if (path) pending.start(req, path, Date.now());
    });
    page.on("requestfinished", (req) => pending.finish(req));
    page.on("requestfailed", (req) => {
      pending.finish(req);
      const path = apiPath(req.url(), this.webUrl);
      if (path) this.log?.warn("web api request failed", { ...fields, path, error: req.failure()?.errorText ?? "" });
    });
    page.on("response", (res) => {
      if (res.status() < 400) return;
      const path = apiPath(res.url(), this.webUrl);
      if (path) this.log?.warn("web api error", { ...fields, path, status: res.status() });
    });
  }

  /**
   * When TanStack's client hydration finds no bootstrap data (the page then stays inert), log
   * what the window holds and where the served document put the bootstrap and the entry module,
   * once per document.
   */
  private trackHydration(page: Page, name: string): void {
    let lastDocument: Response | null = null;
    const reported = new WeakSet<Response>();
    page.on("response", (res) => {
      const req = res.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) lastDocument = res;
    });
    page.on("pageerror", (err) => {
      const doc = lastDocument;
      if (!isHydrationBootError(err.message) || (doc && reported.has(doc))) return;
      if (doc) reported.add(doc);
      void (async () => {
        const state = await page.evaluate(readBootState).catch((e: unknown) => ({ error: String(e) }));
        const served = doc
          ? await Promise.race([
              doc.text().then(documentScriptOrder, (e: unknown) => ({ error: String(e) })),
              new Promise((resolve) => setTimeout(() => resolve({ error: "body not read in 5 s" }), 5_000)),
            ])
          : null;
        this.log?.warn("web hydration found no bootstrap", {
          session: this.label,
          page: name,
          path: doc ? new URL(doc.url()).pathname : null,
          status: doc?.status() ?? null,
          state,
          served,
        });
      })();
    });
  }

  /** Navigate a page to a web app path (or absolute URL). */
  async goto(path: string, name = "main"): Promise<Page> {
    const page = await this.page(name);
    const url = new URL(path, this.webUrl).toString();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (err) {
      // A navigation the page started itself (the redirect after sign-in, in WebKit after the
      // sign-in flow has already seen it land) can interrupt this one: let it finish, then go again.
      if (!(err instanceof Error && err.message.includes("is interrupted by another navigation"))) throw err;
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
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
      for (const call of this.pending.get(name)?.olderThan(Date.now(), PENDING_REPORT_MS) ?? [])
        this.log?.warn("web api call pending", { session: this.label, page: name, ...call });
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
