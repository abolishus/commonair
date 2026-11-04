// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit D5-settings' `d-surfaces` steps (.claude/briefs/d/D5-settings.md), on the seeded stack:
 *
 * - F27: as the seeded viewer, `/settings/privacy` shows the settings navigation (the tab row from
 *   `sm` up, the select below it) with Privacy current;
 * - F37: the account deletion control is within the first viewport, above the long sections.
 */
import type { Page } from "playwright";
import { waitForHydration } from "../web/session.ts";
import type { DContext } from "./context.ts";

const UI_TIMEOUT_MS = 15_000;
const PRIVACY = "/settings/privacy";

async function open(ctx: DContext, page: Page, path: string): Promise<void> {
  const url = new URL(path, ctx.scenario.env.HARNESS_WEB_URL).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForHydration(page);
}

export async function steps(ctx: DContext): Promise<void> {
  const s = ctx.scenario;
  const page = ctx.viewer;

  await s.step("d5-settings: /settings/privacy has the settings navigation and deletion in sight", async () => {
    await open(ctx, page, PRIVACY);
    const nav = page.locator('[data-testid="settings-nav"]');
    await nav.waitFor({ timeout: UI_TIMEOUT_MS });
    s.assert("the settings navigation marks Privacy", (await nav.getAttribute("data-current")) === "privacy");
    const tab = page.locator('[data-testid="settings-tab-privacy"]');
    const select = page.locator('[data-testid="settings-nav-select"]');
    const [tabShown, selectShown] = await Promise.all([tab.isVisible(), select.isVisible()]);
    s.assert("the tab row or, on a phone, the select is shown", tabShown || selectShown, { tabShown, selectShown });
    if (tabShown) s.check("the Privacy tab is the current page", (await tab.getAttribute("aria-current")) === "page");

    // `deletion-request`, or `deletion-status` when the seeded viewer already has a request.
    const control = page.locator('[data-testid="deletion-request"], [data-testid="deletion-status"]').first();
    await control.waitFor({ timeout: UI_TIMEOUT_MS });
    const box = await control.boundingBox();
    const viewport = page.viewportSize();
    const height = viewport?.height ?? (await page.evaluate(() => window.innerHeight));
    s.assert("the delete control is within the first viewport", box !== null && box.y + box.height <= height, {
      top: box?.y ?? null,
      bottom: box ? box.y + box.height : null,
      viewportHeight: height,
    });
  });
}
