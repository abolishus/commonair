// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit D5-STUDIO's `d-surfaces` steps (.claude/briefs/d/D5-studio.md), on the seeded stack:
 *
 * - F21: as streamer1, `/dashboard` is the control room: the preview and chat panels, live stats,
 *   "Edit stream info", quick actions and the activity feed;
 * - F25: as `newbie` (empty everywhere), `/content` offers an `empty-state-action`.
 *
 * `newbie` is not one of the scenario's signed-in pages, so this file signs it in itself, the same
 * way the scenario signs in the others (the `seed full` password from `DEMO_SEED_PASSWORD`).
 */
import type { Page } from "playwright";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T, tid } from "../web/selectors.ts";
import { WebSession, waitForHydration } from "../web/session.ts";
import type { DContext } from "./context.ts";

const UI_TIMEOUT_MS = 15_000;
/** This unit's own test ids (the stream manager's panels); D0 registered only the shared ones. */
const byTestId = (id: string) => `[data-testid="${id}"]`;
const PANELS = [
  "stream-manager",
  "stream-preview",
  "stream-chat",
  "stream-health",
  "stream-info",
  "stream-quick-actions",
  "stream-activity",
] as const;

async function open(ctx: DContext, page: Page, path: string): Promise<void> {
  const url = new URL(path, ctx.scenario.env.HARNESS_WEB_URL).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForHydration(page);
}

async function signedIn(ctx: DContext, handle: string): Promise<Page | string> {
  const s = ctx.scenario;
  const user = ctx.store.users.find((u) => u.handle === handle);
  if (!user) return `the seed store has no ${handle} (run \`seed full\`)`;
  const password = process.env.DEMO_SEED_PASSWORD;
  if (!password) return "set DEMO_SEED_PASSWORD to the `seed full` run's password";
  const session = await WebSession.open({
    fleet: s.platform.fleet,
    engine: "chromium",
    webUrl: s.env.HARNESS_WEB_URL,
    probeScript: "",
    label: `d-${handle}`,
    log: s.log,
  });
  s.defer(() => session.close());
  const page = await session.goto(ROUTES.signin);
  await signInViaUi(page, { email: user.email, password }, UI_TIMEOUT_MS, s.signal);
  await page.locator(tid(T.navUser)).first().waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
}

export async function steps(ctx: DContext): Promise<void> {
  const s = ctx.scenario;

  await s.step("d5-studio: streamer1's /dashboard is a control room with the preview and chat", async () => {
    const page = ctx.streamer;
    await open(ctx, page, ROUTES.dashboard);
    await page.locator(byTestId("stream-manager")).waitFor({ timeout: UI_TIMEOUT_MS });
    const missing: string[] = [];
    for (const id of PANELS) if ((await page.locator(byTestId(id)).count()) === 0) missing.push(id);
    s.assert("every control-room panel is on /dashboard", missing.length === 0, { missing });
    // The preview slot holds the player (its stage, live or offline), the chat slot the chat panel.
    const preview = page.locator(`${byTestId("stream-preview")} ${byTestId("player")}`);
    s.check("the preview holds the player", (await preview.count()) > 0);
    const chat = page.locator(`${byTestId("stream-chat")} ${byTestId("chat")}`);
    s.check("the chat slot holds the chat panel", (await chat.count()) > 0);
    // F21: the setup cards moved to /dashboard/settings.
    s.check("no stream key card on /dashboard", (await page.locator(byTestId("stream-key-rotate")).count()) === 0);
    await open(ctx, page, "/dashboard/settings");
    await page.locator(byTestId("stream-key-rotate")).waitFor({ timeout: UI_TIMEOUT_MS });
    s.check("the stream key is on /dashboard/settings", true);
  });

  const newbie = await signedIn(ctx, "newbie");
  if (typeof newbie === "string") {
    s.skipStep("d5-studio: newbie's /content offers an empty-state action", newbie);
    return;
  }
  await s.step("d5-studio: newbie's /content offers an empty-state action", async () => {
    await open(ctx, newbie, "/content");
    const action = newbie.locator(tid(T.emptyStateAction));
    await action.first().waitFor({ timeout: UI_TIMEOUT_MS });
    s.assert("an empty-state-action on /content", (await action.count()) >= 1);
    const href = await action.first().getAttribute("href");
    s.check(
      "it links to the stream settings or the stream manager",
      href === "/dashboard/settings" || href === "/dashboard",
      {
        href,
      },
    );
  });
}
