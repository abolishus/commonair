// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit D2-CHANNEL's `d-surfaces` steps (.claude/briefs/d/D2-channel.md), on the seeded stack:
 *
 * - F2: `demo_streamer1`'s Videos tab (`?tab=videos`) lists its ready VODs, and Back returns Home;
 * - F2: an offline seeded channel with a ready VOD shows `channel-offline-hero`, linking to it;
 * - F2: About shows the bio card and the channel's panels (once B8-web and D1-seed are merged);
 * - F9: a live channel's header links its category and has Share and uptime;
 * - F4: at 375 px the name keeps its width and Report sits in the "More" menu.
 *
 * Each check first asks the API what the page should show, so a seed without that data skips the
 * step with the reason instead of failing it.
 */
import type { Page } from "playwright";
import { ROUTES, TEST_IDS as T, tid } from "../web/selectors.ts";
import { waitForHydration } from "../web/session.ts";
import type { DContext } from "./context.ts";

const UI_TIMEOUT_MS = 15_000;
/** The seeded streamer with data (`demo_streamer1`, live in Art under `seed live`). */
const STREAMER = "streamer1";
/** A 375 px phone (screenshots 13 and 24). */
const PHONE = { width: 375, height: 812 };

async function open(ctx: DContext, page: Page, path: string): Promise<void> {
  const url = new URL(path, ctx.scenario.env.HARNESS_WEB_URL).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForHydration(page);
}

export async function steps(ctx: DContext): Promise<void> {
  const s = ctx.scenario;
  const api = s.platform.api().client;
  const page = ctx.anonymous;
  const slugOf = (handle: string) => ctx.store.channels.find((c) => c.ownerHandle === handle)?.slug ?? null;
  const readyVods = async (channel: string) =>
    (await api.vods.list({ channel, limit: 25 })).items.filter((v) => v.status === "ready");

  const streamer = slugOf(STREAMER);
  if (!streamer) {
    s.check(`d2-channel: the store has ${STREAMER}'s channel`, false);
    return;
  }

  const vods = await readyVods(streamer);
  if (vods.length === 0)
    s.skipStep("d2-channel: the Videos tab lists VODs", `${streamer} has no ready VOD in this seed`);
  else
    await s.step("d2-channel: the Videos tab lists VODs, and Back returns Home", async () => {
      await open(ctx, page, ROUTES.channel(streamer));
      await page.locator(tid(T.channelTabs, { tab: "home" })).waitFor({ timeout: UI_TIMEOUT_MS });
      await page.locator(tid(T.channelTabVideos)).click({ timeout: UI_TIMEOUT_MS });
      await page.waitForURL(/[?&]tab=videos\b/, { timeout: UI_TIMEOUT_MS });
      const grid = page.locator(tid(T.channelVideoGrid, { kind: "vods", state: "ready" }));
      await grid.waitFor({ timeout: UI_TIMEOUT_MS });
      const cards = grid.locator('[data-testid="channel-video-card"]');
      const shown = await cards.count();
      s.assert("the Videos grid shows the channel's VODs", shown > 0, { shown, ready: vods.length });
      const href = await cards.first().locator("a").getAttribute("href");
      s.check("a card links to its VOD page", href?.startsWith(`/${streamer}/vods/`) === true, { href });
      await page.goBack();
      await page.locator(tid(T.channelTabs, { tab: "home" })).waitFor({ timeout: UI_TIMEOUT_MS });
      s.check("Back returns to Home", !new URL(page.url()).searchParams.has("tab"), { url: page.url() });
    });

  await s.step("d2-channel: an offline channel with a VOD shows the hero", async () => {
    let target: { slug: string; vod: string } | null = null;
    for (const c of ctx.store.channels.filter((x) => x.slug.startsWith("demo_")).slice(0, 25)) {
      const dto = await api.channels.get({ channel: c.slug });
      if (dto.live !== null || dto.suspended) continue;
      const ready = await readyVods(c.slug);
      if (ready[0]) {
        target = { slug: c.slug, vod: ready[0].id };
        break;
      }
    }
    if (!target) {
      s.skipStep("d2-channel: offline hero", "no offline demo channel has a ready VOD in this seed");
      return;
    }
    await open(ctx, page, ROUTES.channel(target.slug));
    const hero = page.locator(tid(T.channelOfflineHero));
    await hero.waitFor({ timeout: UI_TIMEOUT_MS });
    s.check("the hero is the latest VOD", (await hero.getAttribute("data-vod")) === target.vod, target);
    const href = await hero.locator("a").first().getAttribute("href");
    s.check("the hero links to the VOD page", href === `/${target.slug}/vods/${target.vod}`, { href });
  });

  const dto = await api.channels.get({ channel: streamer });
  await s.step("d2-channel: About shows the bio card and the panels", async () => {
    await open(ctx, page, `${ROUTES.channel(streamer)}?tab=about`);
    await page.locator('[data-testid="channel-about"]').waitFor({ timeout: UI_TIMEOUT_MS });
    if (dto.panels.length === 0) {
      s.skipStep("d2-channel: About panels", `${streamer} has no panels (needs B8-web and D1-seed)`);
      return;
    }
    const panels = page.locator('[data-testid="channel-about"] [data-testid="channel-panel"]');
    await panels.first().waitFor({ timeout: UI_TIMEOUT_MS });
    s.check("About lists the channel's panels", (await panels.count()) > 0, { panels: dto.panels.length });
  });

  if (dto.live === null) s.skipStep("d2-channel: live metadata", `${streamer} is not live (run \`seed live\`)`);
  else
    await s.step("d2-channel: live metadata under the title", async () => {
      await open(ctx, page, ROUTES.channel(streamer));
      await page.locator(tid(T.channelMetaUptime)).waitFor({ timeout: UI_TIMEOUT_MS });
      const category = dto.live?.category ?? dto.category;
      if (category) {
        const href = await page.locator(tid(T.channelMetaCategory)).first().getAttribute("href");
        s.check("the category links into the directory", href === ROUTES.category(category.slug), { href });
      }
      s.check("Share is there", await page.locator(tid(T.channelShare)).isVisible());
      const title = await page.title();
      // en `pageTitle.channelLive` ("{name} (live)"): the plain name alone means the live title regressed.
      s.check("the title says (live)", title.includes(`${dto.displayName} (live)`), { title });
    });

  await s.step("d2-channel: the header holds at 375 px", async () => {
    const before = page.viewportSize();
    await page.setViewportSize(PHONE);
    try {
      await open(ctx, page, ROUTES.channel(streamer));
      const name = page.locator("main h1").first();
      await name.waitFor({ timeout: UI_TIMEOUT_MS });
      const box = await name.boundingBox();
      // Screenshots 13 and 24: the name had shrunk to one glyph (~10 px).
      s.check("the channel name keeps its width", (box?.width ?? 0) >= 80, { width: box?.width });
      s.check("Report is in the More menu", await page.locator('[data-testid="channel-overflow"]').isVisible());
      s.check("the Report button is hidden on a phone", !(await page.locator(tid(T.reportOpen)).isVisible()));
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      s.check("no horizontal scroll", scroll <= 0, { scroll });
    } finally {
      if (before) await page.setViewportSize(before);
    }
  });
}
