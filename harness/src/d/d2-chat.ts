// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit D2-CHAT's `d-surfaces` steps (.claude/briefs/d/D2-chat.md, design review F6), on the
 * seeded stack:
 *
 * - streamer1's channel (a live poll, a locked prediction and giveaways under `seed full`) shows
 *   `chat-pinned-strip` folded to one line; expanding it shows the full card of the top item, and
 *   a pinned prediction's card when there is one;
 * - at 1440×900 the chat column reaches the bottom of the viewport;
 * - an offline channel with a quiet chat says so instead of "No messages yet".
 */
import type { Page } from "playwright";
import { E8_TEST_IDS as E8 } from "../e8/selectors.ts";
import { ROUTES, TEST_IDS as T, tid } from "../web/selectors.ts";
import { waitForHydration } from "../web/session.ts";
import type { DContext } from "./context.ts";

const UI_TIMEOUT_MS = 15_000;
/** The card each pinned kind expands to (e8 and w3-giveaways selectors). */
const CARD: Record<string, string> = {
  prediction: E8.chatPrediction,
  poll: E8.chatPoll,
  giveaway: "chat-giveaway",
};
/** D2-chat's offline state; not in `D_TEST_IDS` yet (contract request). */
const CHAT_OFFLINE = "chat-offline";
/** Ids outside the web registry (other units' cards, D2-chat's unregistered state). */
const byTestId = (id: string) => `[data-testid="${id}"]`;

/**
 * Unfold the chat's pinned strip so its cards are visible (they stay mounted but hidden while it
 * is folded). One click expands every pinned card. For scenarios that wait on or click a chat
 * poll, prediction or giveaway card; a no-op when there is no strip or it is already expanded.
 */
export async function expandPinnedStrip(page: Page, timeout = UI_TIMEOUT_MS): Promise<void> {
  const toggle = page.locator(`${tid(T.chatPinnedStrip)} [data-part="toggle"]`);
  await toggle.waitFor({ timeout }).catch(() => undefined);
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click({ timeout });
}

async function open(ctx: DContext, page: Page, path: string): Promise<void> {
  const url = new URL(path, ctx.scenario.env.HARNESS_WEB_URL).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForHydration(page);
}

export async function steps(ctx: DContext): Promise<void> {
  const s = ctx.scenario;
  const api = s.platform.api().client;
  const streamer1 = ctx.store.channels.find((c) => c.ownerHandle === "streamer1")?.slug;
  if (!streamer1) {
    s.skipStep("d2-chat: the pinned strip", "the seed store has no streamer1 channel (run `seed full`)");
    return;
  }

  await s.step("d2-chat: streamer1's chat folds its cards into chat-pinned-strip", async () => {
    const page = ctx.viewer;
    await open(ctx, page, ROUTES.channel(streamer1));
    const strip = page.locator(tid(T.chatPinnedStrip));
    await strip.waitFor({ timeout: UI_TIMEOUT_MS });
    const toggle = strip.locator('[data-part="toggle"]');
    s.check("the strip starts folded", (await toggle.getAttribute("aria-expanded")) === "false");
    const kind = (await strip.getAttribute("data-kind")) ?? "";
    const count = Number(await strip.getAttribute("data-count"));
    s.check("the strip names its top item's kind", kind in CARD, { kind });
    if (count > 1)
      s.check("+N counts the other items", (await strip.locator('[data-part="more"]').count()) === 1, { count });
    await toggle.click({ timeout: UI_TIMEOUT_MS });
    s.assert("the strip expands", (await toggle.getAttribute("aria-expanded")) === "true");
    const top = CARD[kind];
    if (top) await page.locator(byTestId(top)).first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
    // The seed gives streamer1 a prediction; skip only when the API agrees there is none now
    // (a step earlier in the run may have resolved it), so a strip that drops it fails.
    const current = await api.interact.predictions.current({ channel: streamer1 }).catch(() => null);
    const prediction = page.locator(byTestId(E8.chatPrediction));
    if (!current) {
      s.skipStep("d2-chat: the expanded prediction card", "streamer1 has no current prediction");
    } else {
      await prediction
        .first()
        .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS })
        .catch(() => undefined);
      s.assert("expanding shows the prediction card", await prediction.first().isVisible(), {
        prediction: current.id,
      });
    }
    await page.keyboard.press("Escape");
    s.check("Escape folds it again", (await toggle.getAttribute("aria-expanded")) === "false");
  });

  await s.step("d2-chat: the chat column reaches the bottom of a 1440×900 viewport", async () => {
    const page = ctx.viewer;
    const before = page.viewportSize();
    await page.setViewportSize({ width: 1440, height: 900 });
    try {
      await open(ctx, page, ROUTES.channel(streamer1));
      const chat = page.locator(tid("chat"));
      await chat.waitFor({ timeout: UI_TIMEOUT_MS });
      // The full-height column needs D2-channel to apply `chatColumnClass` (contract request);
      // until the channel page does, the panel keeps its fixed height and there is nothing to check.
      const applied = await chat.evaluate((el) => el.classList.contains("chat-column"));
      if (!applied) {
        s.skipStep("d2-chat: the full-height column", "the channel page does not apply chatColumnClass yet");
        return;
      }
      const box = await chat.boundingBox();
      const bottom = box ? box.y + box.height : 0;
      // The page's 1rem bottom padding is the only gap (a little slack for borders and rounding).
      s.check("chat ends within 24 px of the viewport's bottom", bottom <= 900 && bottom >= 876, { bottom });
    } finally {
      if (before) await page.setViewportSize(before);
    }
  });

  await s.step("d2-chat: an offline channel's quiet chat says why", async () => {
    let offline: string | null = null;
    for (const c of ctx.store.channels) {
      const ch = await api.channels.get({ channel: c.slug }).catch(() => null);
      if (ch && ch.live === null && !ch.mature) {
        offline = c.slug;
        break;
      }
    }
    if (!offline) {
      s.skipStep("d2-chat: offline chat", "every seeded channel is live");
      return;
    }
    const page = ctx.anonymous;
    await open(ctx, page, ROUTES.channel(offline));
    await page.locator(tid("chat")).waitFor({ timeout: UI_TIMEOUT_MS });
    const quiet = page.locator(byTestId(CHAT_OFFLINE));
    const spoken = page.locator(tid("chat-message"));
    await quiet
      .or(spoken.first())
      .first()
      .waitFor({ timeout: UI_TIMEOUT_MS })
      .catch(() => undefined);
    s.check(
      "an offline channel shows chat-offline or its messages, never an empty log",
      (await quiet.count()) === 1 || (await spoken.count()) > 0,
      { channel: offline },
    );
  });
}
