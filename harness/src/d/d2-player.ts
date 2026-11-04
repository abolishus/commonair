// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit D2-player's `d-surfaces` steps (.claude/briefs/d/D2-player.md), on the seeded stack, as the
 * seeded viewer on `/demo_streamer1` (live under `seed live`):
 *
 * - F3: hovering the player shows the control bar (`player-controls`);
 * - F5: the settings menu (`player-settings`) holds the data saver;
 * - F3: `t` toggles theatre mode, once D2-channel mounts the page's theatre provider (skipped, with
 *   the reason, until then).
 */
import type { Page } from "playwright";
import { D_TEST_IDS as D, ROUTES, TEST_IDS as T, tid } from "../web/selectors.ts";
import { waitForHydration } from "../web/session.ts";
import type { DContext } from "./context.ts";

const UI_TIMEOUT_MS = 15_000;
const PLAY_TIMEOUT_MS = 45_000;
const CHANNEL = "demo_streamer1";
/** W1's data saver switch (docs/testing/w1-selectors.md "Data mode"), not a D id. */
const DATA_MODE_TOGGLE = '[data-testid="data-mode-toggle"]';

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

/** Whether the channel's player reached `playing` (the seed's live stream is up). */
async function playing(page: Page): Promise<boolean> {
  return page
    .locator(`${tid(T.player)}[data-state="playing"]`)
    .waitFor({ timeout: PLAY_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
}

export async function steps(ctx: DContext): Promise<void> {
  const s = ctx.scenario;
  const page = ctx.viewer;
  let live = false;

  await s.step("d2-player: the control bar shows on hover", async () => {
    await open(ctx, page, ROUTES.channel(CHANNEL));
    await dismissConsent(page);
    live = await playing(page);
    if (!live) {
      s.skipStep("d2-player: control bar", `${CHANNEL} is not playing: run \`seed live\` first`);
      return;
    }
    const bar = page.locator(tid(D.playerControls));
    // Away from the player for longer than the 3 s auto-hide, then over it.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(3_500);
    await page.locator(tid(T.player)).hover();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("data-visible") === "true",
      tid(D.playerControls),
      { timeout: UI_TIMEOUT_MS },
    );
    s.assert("player-controls is visible on hover", await bar.isVisible());
    for (const id of [D.playerSettings, D.playerFullscreen])
      s.check(`${id} is in the bar`, (await bar.locator(tid(id)).count()) === 1);
  });

  await s.step("d2-player: the settings menu holds the data saver", async () => {
    if (!live) {
      s.skipStep("d2-player: settings", `${CHANNEL} is not playing`);
      return;
    }
    await page.locator(tid(T.player)).hover();
    await page.locator(tid(D.playerSettings)).click({ timeout: UI_TIMEOUT_MS });
    const toggle = page.locator(DATA_MODE_TOGGLE);
    await toggle.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
    s.assert("the data saver switch shows in the open menu", await toggle.isVisible());
    s.check(
      "no data saver card under the player any more",
      (await page.locator(`${tid(T.player)} ~ section ${DATA_MODE_TOGGLE}`).count()) === 0,
    );
    await page.keyboard.press("Escape");
    await toggle.waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });
  });

  await s.step("d2-player: t toggles theatre mode", async () => {
    if (!live) {
      s.skipStep("d2-player: theatre", `${CHANNEL} is not playing`);
      return;
    }
    if ((await page.locator(tid(D.playerTheatre)).count()) === 0) {
      // `$channel.tsx` is D2-channel's: it mounts `TheatreProvider` (player/theatre.ts).
      s.skipStep("d2-player: theatre", "waiting on D2-channel mounting TheatreProvider");
      return;
    }
    const player = page.locator(tid(T.player));
    const before = await player.getAttribute("data-theatre");
    // Shortcuts act with focus on the page body.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("t");
    await page.waitForFunction(
      ([sel, was]) => document.querySelector(sel)?.getAttribute("data-theatre") !== was,
      [tid(T.player), before] as const,
      { timeout: UI_TIMEOUT_MS },
    );
    s.assert("t flips data-theatre", (await player.getAttribute("data-theatre")) !== before, { before });
    await page.keyboard.press("t");
    s.check("t again restores it", (await player.getAttribute("data-theatre")) === before);
  });
}
