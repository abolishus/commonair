// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit D1-WEB's `d-surfaces` steps (.claude/briefs/d/D1-web.md), on the seeded stack:
 *
 * - F1: `/directory` lists every category the API counts a live channel in;
 * - F1: `/directory/art` shows streamer1 (live in Art under `seed live`);
 * - F1: a search for "streamer" finds the demo streamers (streamer1..3);
 * - F7: the left rail shows a live row (skipped, with the reason, until `_app.tsx` mounts it).
 */
import type { Page } from "playwright";
import { createApi } from "../api/client.ts";
import { D_TEST_IDS as D, ROUTES, tid } from "../web/selectors.ts";
import { waitForHydration } from "../web/session.ts";
import type { DContext } from "./context.ts";

const UI_TIMEOUT_MS = 15_000;
const STREAMERS = ["streamer1", "streamer2", "streamer3"] as const;

async function open(ctx: DContext, page: Page, path: string): Promise<void> {
  const url = new URL(path, ctx.scenario.env.HARNESS_WEB_URL).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForHydration(page);
}

/** A seeded handle's channel slug (the seed names channels after their owners). */
function slugOf(ctx: DContext, handle: string): string {
  return ctx.store.channels.find((c) => c.ownerHandle === handle)?.slug ?? handle;
}

async function attr(page: Page, selector: string, name: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((els, n) => els.map((el) => el.getAttribute(n) ?? ""), name);
}

export async function steps(ctx: DContext): Promise<void> {
  const s = ctx.scenario;
  const page = ctx.anonymous;
  const api = createApi({ baseUrl: s.env.HARNESS_API_URL });

  await s.step("d1-web: /directory lists every category with a live channel", async () => {
    const { items } = await api.client.categories.list({ limit: 100 });
    const live = items.filter((c) => c.liveChannels > 0).map((c) => c.slug);
    s.assert("the seed has a category with a live channel", live.length > 0, { categories: items.length });
    await open(ctx, page, ROUTES.browse);
    await page.locator(tid(D.directoryCategoryGrid)).waitFor({ timeout: UI_TIMEOUT_MS });
    const shown = await attr(page, `${tid(D.directoryCategoryGrid)} [data-testid="category-tile"]`, "data-category");
    const missing = live.filter((slug) => !shown.includes(slug));
    s.assert("every live category has a tile", missing.length === 0, { missing, shown });
    // Busiest first (F20's corrected counts): the first tile has the most live channels.
    const top = Math.max(...items.map((c) => c.liveChannels));
    const first = items.find((c) => c.slug === shown[0]);
    s.check("the busiest category comes first", first?.liveChannels === top, { first: shown[0], top });
    s.check(
      "Browse is the current nav item",
      (await page.locator('[data-testid="nav-directory"][aria-current="page"]').count()) === 1,
    );
  });

  await s.step("d1-web: /directory/art shows streamer1", async () => {
    const slug = slugOf(ctx, "streamer1");
    await open(ctx, page, ROUTES.category("art"));
    await page.locator(tid(D.categoryPage)).waitFor({ timeout: UI_TIMEOUT_MS });
    s.assert("the Live tab is there", (await page.locator(tid(D.categoryTabLive)).count()) === 1);
    const card = page.locator(`${tid(D.categoryPage)} [data-testid="stream-card"][data-channel="${slug}"]`);
    const found = await card
      .first()
      .waitFor({ timeout: UI_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    s.assert(`${slug} is live in Art`, found, { slug });
    s.check("the page has a title of its own", / · \S/.test(await page.title()), { title: await page.title() });
  });

  await s.step("d1-web: an unknown category is a not-found page with a way out", async () => {
    await open(ctx, page, ROUTES.category("d1-no-such-category-xyz"));
    const action = page.locator(tid(D.emptyStateAction));
    await action.first().waitFor({ timeout: UI_TIMEOUT_MS });
    s.check("it offers Browse live channels", (await action.first().getAttribute("href")) === ROUTES.browse);
  });

  await s.step('d1-web: a search for "streamer" finds the demo streamers', async () => {
    await open(ctx, page, ROUTES.search("streamer"));
    await page.locator(tid(D.searchPage)).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator(tid(D.searchResultsChannels)).waitFor({ timeout: UI_TIMEOUT_MS });
    const found = await attr(page, `${tid(D.searchResultsChannels)} [data-testid="search-channel"]`, "data-channel");
    const wanted = STREAMERS.map((h) => slugOf(ctx, h));
    const missing = wanted.filter((slug) => !found.includes(slug));
    s.assert("streamer1, streamer2 and streamer3 are found", missing.length === 0, { found, missing });
    const announced = (await page.locator('[data-testid="search-announcement"]').textContent()) ?? "";
    s.check("the count is announced", /\d/.test(announced), { announced });
  });

  await s.step("d1-web: the header search goes to /search", async () => {
    await open(ctx, page, ROUTES.browse);
    const field = page.locator(`${tid(D.headerSearch)} input`);
    if (!(await field.isVisible().catch(() => false))) {
      s.skipStep("d1-web: header search", "the header field is hidden at this viewport (below md)");
      return;
    }
    await field.fill("streamer");
    await field.press("Enter");
    await page.waitForURL((url) => url.pathname === "/search" && url.searchParams.get("q") === "streamer", {
      timeout: UI_TIMEOUT_MS,
    });
  });

  await s.step("d1-web: the left rail shows a live row", async () => {
    await open(ctx, page, ROUTES.browse);
    const rail = page.locator(tid(D.sideRail));
    const mounted = await rail
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!mounted) {
      // `routes/_app.tsx` is not D1-web's: it mounts `AppRail` (contract request).
      s.skipStep("d1-web: rail", "waiting on _app.tsx passing sidebar={<AppRail />} to AppShell");
      return;
    }
    const row = page.locator(`${tid(D.sideRail)} ${tid(D.sideRailItem)}[data-live="true"]`);
    await row.first().waitFor({ timeout: UI_TIMEOUT_MS });
    s.assert("the rail has a live row", (await row.count()) > 0);
  });
}
