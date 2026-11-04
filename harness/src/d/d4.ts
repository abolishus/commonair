// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit D4's `d-surfaces` steps (.claude/briefs/d/D4-polish.md), on the seeded stack:
 *
 * - F16: the first Tab on `/` lands on the skip link;
 * - F13: a dead end offers "Browse live channels" (`empty-state-action`): the admin layout's
 *   not-found page for a signed-out visitor, and an unknown channel once D2-channel has adopted the
 *   shared state (skipped, with the reason, until then);
 * - F15: `/`, `/coop` and `/transparency` have three different document titles.
 */
import type { Page } from "playwright";
import { ROUTES, TEST_IDS as T, tid } from "../web/selectors.ts";
import { waitForHydration } from "../web/session.ts";
import type { DContext } from "./context.ts";

const UI_TIMEOUT_MS = 15_000;
/** No seeded channel has this slug (seed slugs are `demo_*`, `streamer*`, `viewer*`, …). */
const UNKNOWN_CHANNEL = "d4-no-such-channel-xyz123";

async function open(ctx: DContext, page: Page, path: string): Promise<void> {
  const url = new URL(path, ctx.scenario.env.HARNESS_WEB_URL).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForHydration(page);
}

/** The first visit's storage banner sits above the page: answer it (no optional storage) first. */
async function dismissConsent(page: Page): Promise<void> {
  const reject = page.locator('[data-testid="consent-reject"]');
  if (await reject.isVisible().catch(() => false)) {
    await reject.click({ timeout: UI_TIMEOUT_MS });
    await page.locator('[data-testid="consent-banner"]').waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
  }
}

export async function steps(ctx: DContext): Promise<void> {
  const s = ctx.scenario;
  const page = ctx.anonymous;

  await s.step("d4: the first Tab on / lands on the skip link", async () => {
    await open(ctx, page, ROUTES.home);
    await dismissConsent(page);
    // From the top of a fresh load, as a keyboard user arrives.
    await open(ctx, page, ROUTES.home);
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
    s.assert("first Tab focuses skip-link", focused === T.skipLink, { focused });
    const shown = await page.locator(tid(T.skipLink)).isVisible();
    s.check("the focused skip link is visible", shown);
    await page.keyboard.press("Enter");
    const inMain = await page.evaluate(() => document.activeElement?.id ?? null);
    s.check("Enter moves focus to the main landmark", inMain === "main-content", { inMain });
  });

  await s.step("d4: a page the visitor may not see offers Browse live channels", async () => {
    // `/treasury` signed out: the admin layout's guard renders its not-found page.
    await open(ctx, page, ROUTES.treasury);
    const action = page.locator(tid(T.emptyStateAction));
    await action.first().waitFor({ timeout: UI_TIMEOUT_MS });
    s.assert("the not-found page has one empty-state-action", (await action.count()) === 1);
    const href = await action.first().getAttribute("href");
    s.check("it links to the directory", href === ROUTES.directory || href === ROUTES.browse, { href });
  });

  await s.step("d4: an unknown channel offers Browse live channels", async () => {
    await open(ctx, page, ROUTES.channel(UNKNOWN_CHANNEL));
    const action = page.locator(tid(T.emptyStateAction));
    await action.first().waitFor({ timeout: UI_TIMEOUT_MS });
    s.assert("the unknown channel's state has an action", (await action.count()) >= 1);
  });

  await s.step("d4: /, /coop and /transparency have their own titles", async () => {
    const titles: Record<string, string> = {};
    for (const path of [ROUTES.home, "/coop", ROUTES.transparency]) {
      await open(ctx, page, path);
      titles[path] = await page.title();
    }
    const values = Object.values(titles);
    s.assert("three different document titles", new Set(values).size === values.length, titles);
    s.check(
      "each names the site after a middle dot",
      values.every((v) => / · \S/.test(v)),
      titles,
    );
  });
}
