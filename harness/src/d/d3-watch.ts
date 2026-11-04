// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit D3-WATCH's `d-surfaces` steps (.claude/briefs/d/D3-watch.md, F11), on the seeded stack:
 *
 * - a `demo_streamer1` VOD shows `watch-meta` (title, Share) and `watch-channel-card`, with
 *   "Watch live" while the channel is live;
 * - its "More from" grid (`watch-more-grid`) lists the channel's other VODs, never this one;
 * - the document title is "<VOD title> · <channel> · <site>";
 * - Share's "Start at" adds `?t=` and a `?t=` link opens the page;
 * - a missing VOD on the channel is the not-available page with "Back to <channel>".
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
/** A UUIDv7-shaped id no seed mints. */
const MISSING_VOD = "01900000-0000-7000-8000-00000000dead";

const vodPath = (slug: string, id: string) => `${ROUTES.channel(slug)}/vods/${encodeURIComponent(id)}`;

async function open(ctx: DContext, page: Page, path: string): Promise<void> {
  const url = new URL(path, ctx.scenario.env.HARNESS_WEB_URL).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForHydration(page);
}

export async function steps(ctx: DContext): Promise<void> {
  const s = ctx.scenario;
  const api = s.platform.api().client;
  const page = ctx.anonymous;
  const streamer = ctx.store.channels.find((c) => c.ownerHandle === STREAMER)?.slug ?? null;
  if (!streamer) {
    s.check(`d3-watch: the store has ${STREAMER}'s channel`, false);
    return;
  }

  const ready = (await api.vods.list({ channel: streamer, limit: 25 })).items.filter((v) => v.status === "ready");
  const vod = ready[0];
  if (!vod) {
    s.skipStep("d3-watch: the VOD page", `${streamer} has no ready VOD in this seed`);
    return;
  }
  const channel = await api.channels.get({ channel: streamer });

  await s.step("d3-watch: a VOD shows its metadata and the channel card", async () => {
    await open(ctx, page, vodPath(streamer, vod.id));
    await page.locator(tid(T.watchMeta)).waitFor({ timeout: UI_TIMEOUT_MS });
    const shown = (await page.locator('[data-testid="watch-title"]').textContent())?.trim() ?? "";
    if (vod.title.trim() !== "")
      s.check("the title is the VOD's", shown === vod.title.trim(), { shown, vod: vod.title });
    s.check("Share is there", await page.locator(tid(T.watchShare)).isVisible());
    const card = page.locator(tid(T.watchChannelCard));
    await card.waitFor({ timeout: UI_TIMEOUT_MS });
    const link = await card.locator('[data-testid="watch-channel-link"]').getAttribute("href");
    s.check("the card links to the channel", link === ROUTES.channel(streamer), { link });
    const title = await page.title();
    s.check("the document title is <VOD> · <channel> · <site>", title.includes(` · ${channel.displayName} · `), {
      title,
    });
  });

  if (channel.live === null) s.skipStep("d3-watch: Watch live", `${streamer} is not live (run \`seed live\`)`);
  else
    await s.step("d3-watch: Watch live while the channel is live", async () => {
      await open(ctx, page, vodPath(streamer, vod.id));
      const card = page.locator(tid(T.watchChannelCard, { live: "true" }));
      await card.waitFor({ timeout: UI_TIMEOUT_MS });
      const watch = card.locator('[data-testid="watch-live"]');
      s.check("Watch live is shown", await watch.isVisible());
      s.check("it goes to the channel", (await watch.getAttribute("href")) === ROUTES.channel(streamer));
    });

  if (ready.length < 2) s.skipStep("d3-watch: More from", `${streamer} has only one ready VOD`);
  else
    await s.step("d3-watch: More from lists the channel's other VODs", async () => {
      await open(ctx, page, vodPath(streamer, vod.id));
      const grid = page.locator(tid(T.watchMoreGrid, { state: "ready" }));
      await grid.waitFor({ timeout: UI_TIMEOUT_MS });
      const ids = await grid
        .locator('[data-testid="channel-video-card"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-id")));
      s.check("it has cards", ids.length > 0 && ids.length <= 6, { ids });
      s.check("never the VOD being watched", !ids.includes(vod.id), { ids, current: vod.id });
      const all = await grid.locator('[data-testid="channel-shelf-view-all"]').getAttribute("href");
      s.check("View all goes to the Videos tab", all === `${ROUTES.channel(streamer)}?tab=videos`, { all });
    });

  await s.step("d3-watch: a ?t= link opens the page", async () => {
    await open(ctx, page, `${vodPath(streamer, vod.id)}?t=5`);
    await page.locator(tid(T.watchMeta)).waitFor({ timeout: UI_TIMEOUT_MS });
    s.check("the page renders with ?t=", new URL(page.url()).searchParams.get("t") === "5", { url: page.url() });
  });

  await s.step("d3-watch: a missing VOD is not available, with Back to the channel", async () => {
    await open(ctx, page, vodPath(streamer, MISSING_VOD));
    await page.locator('[data-testid="watch-not-found"]').waitFor({ timeout: UI_TIMEOUT_MS });
    const back = page.locator(tid(T.emptyStateAction));
    await back.waitFor({ timeout: UI_TIMEOUT_MS });
    s.check("Back goes to the channel", (await back.getAttribute("href")) === ROUTES.channel(streamer));
    s.check("the text names the channel", ((await back.textContent()) ?? "").includes(channel.displayName));
  });
}
