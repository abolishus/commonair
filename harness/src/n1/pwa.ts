// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Step 6 (N1-pwa, web only; docs/testing/n1-selectors.md): the manifest names the instance,
 * Chromium finds the app installable, the service worker is active and its cache holds only the
 * app's own static files, and a push delivered over CDP shows one notification for the channel.
 * The click handler is unit-tested (headless Chromium cannot click a notification).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, type CDPSession, type Page, chromium } from "playwright";
import { HUMANIZE_SCRIPT } from "../browser-viewer.ts";
import type { ScenarioContext } from "../scenario.ts";
import { waitForHydration } from "../web/session.ts";
import type { N1Run, N1Step } from "./run.ts";
import { N1_ROUTES } from "./selectors.ts";

const SW_READY_MS = 45_000;
const NOTIFICATION_WAIT_MS = 20_000;
const CDP_EVENT_MS = 15_000;

/** The service worker's caches are all named this (apps/web/src/sw/cache.ts). */
export const SHELL_CACHE_PREFIX = "commonair-shell-";
/** Nothing under these paths may ever be cached (ADR 0028 decision 7). */
export const NEVER_CACHED = ["/api/", "/rpc/", "/hls/", "/media/", "/vod/"] as const;

/** What `/manifest.webmanifest` must say for this instance; empty when it does. */
export function manifestProblems(manifest: unknown, instanceName: string): string[] {
  if (typeof manifest !== "object" || manifest === null) return ["the manifest is not a JSON object"];
  const m = manifest as Record<string, unknown>;
  const problems: string[] = [];
  if (m.name !== instanceName) problems.push(`name is ${JSON.stringify(m.name)}, not the instance's "${instanceName}"`);
  for (const [k, want] of Object.entries({ start_url: "/", scope: "/", display: "standalone", id: "/" }))
    if (m[k] !== want) problems.push(`${k} is ${JSON.stringify(m[k])}, expected "${want}"`);
  const icons = Array.isArray(m.icons) ? (m.icons as Record<string, unknown>[]) : [];
  for (const sizes of ["192x192", "512x512"])
    if (!icons.some((i) => i.sizes === sizes && i.purpose !== "maskable")) problems.push(`no ${sizes} icon`);
  if (!icons.some((i) => i.purpose === "maskable")) problems.push("no maskable icon");
  return problems;
}

export interface CacheDump {
  name: string;
  urls: string[];
}

/** Cache Storage holds only shell caches, with something in them, and nothing personal or media. */
export function cacheProblems(caches: readonly CacheDump[], origin: string): string[] {
  const problems: string[] = [];
  if (caches.length === 0) problems.push("Cache Storage is empty (the worker precached nothing)");
  for (const c of caches) {
    if (!c.name.startsWith(SHELL_CACHE_PREFIX)) problems.push(`unexpected cache "${c.name}"`);
    if (c.urls.length === 0) problems.push(`cache "${c.name}" is empty`);
    for (const raw of c.urls) {
      const url = new URL(raw);
      if (url.origin !== origin) problems.push(`cached another origin: ${url.origin}${url.pathname}`);
      else if (NEVER_CACHED.some((p) => url.pathname.startsWith(p))) problems.push(`cached ${url.pathname}`);
      else if (!url.pathname.startsWith("/assets/") && !url.pathname.startsWith("/icons/"))
        problems.push(`cached something that is not a static file: ${url.pathname}`);
    }
  }
  return problems;
}

export interface ShownNotification {
  title: string;
  tag: string;
  data: unknown;
}

/** Exactly one notification for the channel, naming it and opening `/<slug>`. */
export function notificationProblems(shown: readonly ShownNotification[], slug: string): string[] {
  const mine = shown.filter((n) => n.tag === `go-live-${slug}`);
  if (mine.length !== 1)
    return [`${mine.length} notifications tagged go-live-${slug} (of ${shown.length}), expected 1`];
  const [n] = mine;
  const problems: string[] = [];
  if (!n?.title.includes(slug)) problems.push(`title "${n?.title}" does not name ${slug}`);
  const url = (n?.data as { url?: unknown } | null)?.url;
  if (url !== `/${slug}`) problems.push(`data.url is ${JSON.stringify(url)}, expected "/${slug}"`);
  return problems;
}

/**
 * A browser for the PWA steps: Chromium's new headless mode with a persistent profile, not the
 * fleet's headless shell. The shell never grants the notifications permission to a service worker,
 * and a Playwright incognito context is never installable (`in-incognito`); this profile is both.
 * Closed and deleted when the scenario ends.
 */
export async function pwaBrowserContext(ctx: ScenarioContext, origin: string): Promise<BrowserContext> {
  const dir = mkdtempSync(join(tmpdir(), "commonair-n1-pwa-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(dir, {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      args: ["--mute-audio"],
    });
  } catch (err) {
    remove();
    throw err;
  }
  ctx.defer(async () => {
    await context.close().catch(() => undefined);
    remove();
  });
  await context.addInitScript({ content: HUMANIZE_SCRIPT });
  await context.grantPermissions(["notifications"], { origin });
  return context;
}

/** Open a web app path and wait for hydration (the app's own `html[data-hydrated]`). */
export async function openHydrated(context: BrowserContext, webUrl: string, path: string, page?: Page): Promise<Page> {
  const p = page ?? (await context.newPage());
  await p.goto(new URL(path, webUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (!(await waitForHydration(p))) throw new Error(`${path} did not hydrate`);
  return p;
}

function fail(what: string, problems: readonly string[]): void {
  if (problems.length > 0) throw new Error(`${what}: ${problems.join("; ")}`);
}

/** The active worker's state, waiting for the page's idle-time registration. */
async function activeWorker(page: Page): Promise<string | null> {
  return page.evaluate(
    (ms) =>
      Promise.race([
        navigator.serviceWorker.ready.then((r) => r.active?.state ?? null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
      ]),
    SW_READY_MS,
  );
}

async function dumpCaches(page: Page): Promise<CacheDump[]> {
  return page.evaluate(async () => {
    const out: { name: string; urls: string[] }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out.push({ name, urls: (await cache.keys()).map((r) => r.url) });
    }
    return out;
  });
}

/** The registration id CDP knows the page's worker by. */
async function registrationId(cdp: CDPSession, scopeUrl: string): Promise<string> {
  const found = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no service worker registration for ${scopeUrl} over CDP`)),
      CDP_EVENT_MS,
    );
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => {
      const r = e.registrations.find((reg) => reg.scopeURL === scopeUrl && !reg.isDeleted);
      if (r) {
        clearTimeout(timer);
        resolve(r.registrationId);
      }
    });
  });
  await cdp.send("ServiceWorker.enable");
  return found;
}

async function shownNotifications(page: Page): Promise<ShownNotification[]> {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.getNotifications()).map((n) => ({ title: n.title, tag: n.tag, data: n.data as unknown }));
  });
}

async function run(r: N1Run): Promise<void> {
  const { ctx } = r;
  const webUrl = ctx.env.HARNESS_WEB_URL;
  const origin = new URL(webUrl).origin;

  const instance = await r.platform.api().client.instance.info();
  const res = await fetch(new URL(N1_ROUTES.manifest, webUrl));
  if (!res.ok) throw new Error(`${N1_ROUTES.manifest} answered HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("application/manifest+json")) throw new Error(`${N1_ROUTES.manifest} content type ${type}`);
  fail("manifest", manifestProblems(await res.json(), instance.name));

  const context = await pwaBrowserContext(ctx, origin);
  const page = await openHydrated(context, webUrl, "/");

  const state = await activeWorker(page);
  if (state !== "activated" && state !== "activating")
    throw new Error(`the service worker is not active within ${SW_READY_MS} ms (state ${state})`);
  const cdp = await context.newCDPSession(page);
  ctx.defer(() => cdp.detach().catch(() => undefined));

  const manifest = await cdp.send("Page.getAppManifest", {});
  fail(
    "Page.getAppManifest",
    manifest.errors.map((e) => `${e.critical ? "critical: " : ""}${e.message}`),
  );
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  fail(
    "Page.getInstallabilityErrors",
    installabilityErrors.map((e) => [e.errorId, ...e.errorArguments.map((a) => `${a.name}=${a.value}`)].join(" ")),
  );

  const cached = await dumpCaches(page);
  fail("Cache Storage", cacheProblems(cached, origin));

  // Any path-safe slug: the worker only formats it; nothing is fetched for it.
  const slug = `n1pwa_${crypto.randomUUID().slice(0, 8)}`;
  const id = await registrationId(cdp, `${origin}/`);
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin,
    registrationId: id,
    data: JSON.stringify({ v: 1, type: "go_live", slug, title: "harness push check" }),
  });
  const deadline = Date.now() + NOTIFICATION_WAIT_MS;
  let shown = await shownNotifications(page);
  while (notificationProblems(shown, slug).length > 0 && Date.now() < deadline) {
    await page.waitForTimeout(250);
    shown = await shownNotifications(page);
  }
  fail("notification", notificationProblems(shown, slug));

  ctx.data("n1.pwa", {
    instance: instance.name,
    workerState: state,
    caches: cached.map((c) => ({ name: c.name, entries: c.urls.length })),
    notification: shown.find((n) => n.tag === `go-live-${slug}`)?.title,
  });
}

export const step: N1Step = {
  name: "PWA",
  owner: "N1-pwa",
  needs: [],
  webOnly: true,
  run,
};
