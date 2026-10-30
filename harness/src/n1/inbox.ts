// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Step 5 (N1-inbox, web only; needs step 1; docs/testing/n1-selectors.md "Scenarios" 5), in
 * Chromium as the viewer:
 *
 * 1. The header's `notification-bell` shows `data-unread` ≥ 1 (step 1's go-live).
 * 2. Its popover lists a `go_live` item whose link is `/<first channel>`.
 * 3. `notification-mark-all-read` → `data-unread="0"`, and `notifications.unreadCount` agrees.
 * 4. `/settings/notifications`: flip `notify-default-email` (whatever its state, so the step does
 *    not depend on step 2), `preferences.get` agrees, then flip it back and check again.
 */
import { join } from "node:path";
import type { Page } from "playwright";
import { DEFAULT_REPORT_DIR } from "../report.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import { type N1Run, type N1Step } from "./run.ts";
import { N1_ROUTES, N1_TEST_IDS as N, byN1Id } from "./selectors.ts";

/** A page action plus one API round trip, with room for a loaded CI runner. */
export const UI_TIMEOUT_MS = 30_000;
/** The bell asks for the count on mount; a loaded runner may take a while to hydrate and answer. */
export const BELL_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------- pure helpers (unit-tested)

/** `data-unread` as a number; anything else (missing, empty, not an integer) is null. */
export function unreadOf(attr: string | null): number | null {
  if (attr === null || !/^\d+$/.test(attr)) return null;
  return Number(attr);
}

/** A switch's `data-state` (`on`/`off`) as a boolean; anything else is null. */
export function switchOn(attr: string | null): boolean | null {
  return attr === "on" ? true : attr === "off" ? false : null;
}

/** Whether an item link points at the channel page `/<slug>` (absolute or relative href). */
export function linksToChannel(href: string | null, slug: string, webUrl: string): boolean {
  if (href === null) return false;
  try {
    const url = new URL(href, webUrl);
    return url.origin === new URL(webUrl).origin && url.pathname === `/${slug}` && url.search === "";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the step

const ui = { timeout: UI_TIMEOUT_MS };

async function bellUnread(page: Page): Promise<number | null> {
  return unreadOf(await byN1Id(page, N.bell).getAttribute("data-unread", ui));
}

async function emailDefault(run: N1Run): Promise<boolean> {
  const prefs = await run.actors.viewer.api.client.notifications.preferences.get({ type: "go_live" });
  return prefs.defaults.email;
}

/** Click the email default and wait for both the switch and `preferences.get` to say `want`. */
async function flipEmailDefault(run: N1Run, page: Page, want: boolean): Promise<void> {
  const { ctx } = run;
  const toggle = byN1Id(page, N.defaultEmail);
  await toggle.click(ui);
  await waitFor(
    "notify-default-email to show the change",
    async () => switchOn(await toggle.getAttribute("data-state")) === want,
    {
      timeoutMs: UI_TIMEOUT_MS,
      intervalMs: 250,
      signal: ctx.signal,
    },
  );
  const saved = await waitFor(
    "preferences.get to agree with the switch",
    async () => ((await emailDefault(run)) === want ? true : null),
    { timeoutMs: UI_TIMEOUT_MS, intervalMs: 500, signal: ctx.signal },
  ).catch(() => false);
  ctx.assert(`5. the email default is ${want ? "on" : "off"} in preferences.get`, saved === true, { want });
  ctx.check("5. no save error", (await byN1Id(page, N.saveError).count()) === 0);
}

async function runInbox(run: N1Run, session: WebSession): Promise<void> {
  const { ctx, env } = run;
  const viewer = run.actors.viewer;
  const slug = run.state.firstChannel;
  ctx.assert("5. step 1 left its channel", slug !== undefined);
  if (slug === undefined) return;

  await ctx.step("5. viewer: sign in through the web UI", async () => {
    const page = await session.goto(ROUTES.signin);
    await signInViaUi(page, viewer, UI_TIMEOUT_MS, ctx.signal);
    // Land before the next navigation.
    await byTestId(page, T.navUser, { username: viewer.username }).waitFor(ui);
  });

  const page = await session.goto(ROUTES.directory);
  await ctx.step("5. the bell shows the go-live as unread", async () => {
    const unread = await waitFor(
      "notification-bell data-unread ≥ 1",
      async () => {
        const n = await bellUnread(page);
        return n !== null && n >= 1 ? n : null;
      },
      { timeoutMs: BELL_TIMEOUT_MS, intervalMs: 500, signal: ctx.signal },
    );
    ctx.assert("5. notification-bell data-unread ≥ 1", unread >= 1, { unread });
    ctx.check("5. the badge shows", (await byN1Id(page, N.bellBadge).count()) === 1);
  });

  await ctx.step("5. the popover lists the go-live, linking the channel", async () => {
    await byN1Id(page, N.bell).click(ui);
    await byN1Id(page, N.list).waitFor(ui);
    const links = await byN1Id(page, N.item, { type: "go_live" })
      .locator(`[data-testid="${N.itemLink}"]`)
      .evaluateAll((els) => els.map((el) => el.getAttribute("href")));
    ctx.assert(
      "5. a go_live item links /<slug>",
      links.some((href) => linksToChannel(href, slug, env.HARNESS_WEB_URL)),
      { slug, links },
    );
  });

  await ctx.step("5. mark all read empties the badge", async () => {
    await byN1Id(page, N.markAllRead).click(ui);
    const zero = await waitFor(
      "notification-bell data-unread 0",
      async () => ((await bellUnread(page)) === 0 ? true : null),
      {
        timeoutMs: UI_TIMEOUT_MS,
        intervalMs: 250,
        signal: ctx.signal,
      },
    ).catch(() => false);
    ctx.assert('5. mark all read → data-unread="0"', zero === true);
    ctx.check("5. no badge at 0", (await byN1Id(page, N.bellBadge).count()) === 0);
    const count = await viewer.api.client.notifications.unreadCount();
    ctx.assert("5. notifications.unreadCount agrees (0)", count.count === 0 && !count.capped, count);
    await page.keyboard.press("Escape");
  });

  await ctx.step("5. the settings page flips the email default and back", async () => {
    const settings = await session.goto(N1_ROUTES.settings);
    const toggle = byN1Id(settings, N.defaultEmail);
    await toggle.waitFor(ui);
    const before = switchOn(await toggle.getAttribute("data-state", ui));
    ctx.assert("5. notify-default-email has data-state on|off", before !== null, { before });
    if (before === null) return;
    ctx.assert("5. the switch matches preferences.get", before === (await emailDefault(run)), { before });
    await flipEmailDefault(run, settings, !before);
    await flipEmailDefault(run, settings, before);
  });
}

export const step: N1Step = {
  name: "inbox",
  owner: "N1-inbox",
  needs: [1],
  webOnly: true,
  async run(run) {
    const { ctx } = run;
    const session = await WebSession.open({
      fleet: run.browser ?? run.platform.fleet,
      engine: "chromium",
      webUrl: run.env.HARNESS_WEB_URL,
      probeScript: "",
      label: "n1-inbox",
      log: run.log,
    });
    ctx.defer(() => session.close());
    try {
      await runInbox(run, session);
    } catch (err) {
      const dir = join(run.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${ctx.runId}-${ctx.name}`);
      const files = await session.screenshotAll(dir);
      if (files.length > 0) ctx.data("inboxScreenshots", files);
      throw err;
    }
  },
};
