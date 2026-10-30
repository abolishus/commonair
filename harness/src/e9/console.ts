// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 7 (E9-console; docs/testing/e9-selectors.md "Scenarios"), in Chromium
 * through `data-testid`s only: the developer registers a third app in `/developer` and reads its
 * secret once from `devapp-secret` (it works at the token endpoint, and is gone from the page after
 * `devapp-secret-done`); on the confidential app's page `devsub` shows step 4's subscription
 * `enabled`, `devsub-deliveries` lists step 4's deliveries, `devsub-test` adds one and
 * `devdelivery-redeliver` adds an attempt of step 4's follow notification; `/developer/bots`
 * creates a bot and mints a token (`devbot-token-value`, once; `oauth2/validate` names the bot);
 * an admin finds the third app on `/admin/apps`, suspends it (`adminapp-reason-spam`) and lifts
 * the suspension. Outcomes are checked through the API too.
 *
 * Secrets never reach the report: the client secret and the token are kept in local variables
 * only, failure screenshots blank their elements first, and assertions log ids and booleans.
 */
import { join } from "node:path";
import { OAUTH_PATHS } from "@commonair/contracts/oauth";
import type { Locator, Page } from "playwright";
import { playerBundles } from "../player-server.ts";
import { DEFAULT_REPORT_DIR } from "../report.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import { clientCredentialsForm } from "./app.ts";
import { type E9Run, type E9Step, machineFetch } from "./run.ts";
import { E9_ROUTES, E9_TEST_IDS as T, byE9Id, e9Option, e9tid } from "./selectors.ts";

/** A page action plus one API round trip. */
export const UI_TIMEOUT_MS = 20_000;
/** The delivery log re-reads every 5 s while open; the worker delivers within seconds. */
const DELIVERY_TIMEOUT_MS = 60_000;
const ui = { timeout: UI_TIMEOUT_MS };

/** Elements a failure screenshot blanks: they hold secrets. */
export const SECRET_SELECTORS: readonly string[] = [e9tid(T.devappSecretValue), e9tid(T.devbotTokenValue)];

// ---------------------------------------------------------------- pure helpers

/** The third app's name for this run (the form allows 50 characters). */
export function consoleAppName(runId: string): string {
  return `Console ${runId}`.slice(0, 50);
}

/** A bot username for this run: 3-25 of `[a-z0-9_]`. */
export function consoleBotUsername(runId: string): string {
  return `cb_${runId.toLowerCase().replace(/[^a-z0-9_]/g, "")}`.slice(0, 25);
}

export const looksLikeClientSecret = (v: string): boolean => /^cas_[A-Za-z0-9_-]{16,}$/.test(v);
export const looksLikeAccessToken = (v: string): boolean => /^ca_[A-Za-z0-9_-]{16,}$/.test(v);

export interface DeliveryLike {
  id: string;
  messageId: string;
  messageType: string;
  attempt: number;
  createdAt: string;
}

/**
 * The delivery to redeliver: the oldest notification. Step 4 delivered the follow before it sent
 * a test event, and test events cannot be redelivered, so the oldest one is the follow's.
 */
export function redeliveryTarget<D extends DeliveryLike>(deliveries: readonly D[]): D | null {
  const notes = deliveries.filter((d) => d.messageType === "notification");
  if (notes.length === 0) return null;
  return [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] ?? null;
}

/** The highest attempt logged for one message id (0 when none). */
export function lastAttempt(deliveries: readonly DeliveryLike[], messageId: string): number {
  return deliveries.filter((d) => d.messageId === messageId).reduce((max, d) => Math.max(max, d.attempt), 0);
}

/** Notifications in `after` that were not in `before` (by delivery id). */
export function newNotifications<D extends DeliveryLike>(before: readonly DeliveryLike[], after: readonly D[]): D[] {
  const seen = new Set(before.map((d) => d.id));
  return after.filter((d) => d.messageType === "notification" && !seen.has(d.id));
}

/** Whether a switch with this `aria-checked` must be clicked to reach `want`. */
export function needsToggle(ariaChecked: string | null, want: boolean): boolean {
  return (ariaChecked === "true") !== want;
}

// ---------------------------------------------------------------- browser plumbing

async function session(run: E9Run, label: string, user: SignedInUser): Promise<WebSession> {
  const { ctx } = run;
  const s = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label,
    log: ctx.log,
  });
  ctx.defer(() => s.close());
  const page = await s.goto(ROUTES.signin);
  await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
  await byTestId(page, TEST_IDS.navUser, { username: user.username }).waitFor(ui);
  return s;
}

async function withScreenshots<R>(run: E9Run, sessions: readonly WebSession[], fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    const dir = join(run.ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${run.ctx.runId}-${run.ctx.name}`);
    const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir, SECRET_SELECTORS)))).flat();
    if (files.length > 0) run.ctx.data("consoleScreenshots", files);
    throw err;
  }
}

async function attr(locator: Locator, name: string): Promise<string> {
  await locator.first().waitFor({ state: "attached", ...ui });
  return (await locator.first().getAttribute(name)) ?? "";
}

async function confirmDialog(page: Page): Promise<void> {
  await byTestId(page, TEST_IDS.confirmDialogConfirm).click(ui);
}

async function setSwitch(page: Page, id: string, want: boolean): Promise<void> {
  const el = byE9Id(page, id);
  await el.waitFor(ui);
  if (needsToggle(await el.getAttribute("aria-checked"), want)) await el.click(ui);
}

/** Whether `text` appears anywhere in the page's DOM (inputs included). */
function pageHolds(page: Page, text: string): Promise<boolean> {
  return page.evaluate(
    (t) =>
      document.documentElement.outerHTML.includes(t) ||
      [...document.querySelectorAll("input, textarea")].some((el) => (el as HTMLInputElement).value.includes(t)),
    text,
  );
}

async function allDeliveries(user: SignedInUser, subscriptionId: string) {
  const out = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const p = await user.api.client.developer.events.deliveries({
      id: subscriptionId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...p.items);
    if (!p.nextCursor) break;
    cursor = p.nextCursor;
  }
  return out;
}

// ---------------------------------------------------------------- the step

async function registerThirdApp(run: E9Run, page: Page): Promise<{ id: string; clientId: string }> {
  const { ctx } = run;
  const name = consoleAppName(ctx.runId);
  return ctx.step("7. /developer: register a confidential app, read its secret once", async () => {
    await page.goto(new URL(E9_ROUTES.developer, ctx.env.HARNESS_WEB_URL).toString());
    await byE9Id(page, T.devapps).waitFor(ui);
    await byE9Id(page, T.devappNew).click(ui);
    await byE9Id(page, T.devappForm).waitFor(ui);
    await byE9Id(page, T.devappName).fill(name, ui);
    await byE9Id(page, T.devappDescription).fill("Registered by the harness console step", ui);
    await byE9Id(page, T.devappRedirects).fill("http://127.0.0.1/cb", ui);
    await setSwitch(page, T.devappConfidential, true);
    await byE9Id(page, T.devappSubmit).click(ui);
    const dialog = byE9Id(page, T.devappSecret);
    await dialog.waitFor(ui);
    const clientId = await attr(dialog, "data-client-id");
    const secret = ((await byE9Id(page, T.devappSecretValue).textContent(ui)) ?? "").trim();
    ctx.assert("devapp-secret shows a client secret", looksLikeClientSecret(secret));
    // The secret works: the token endpoint issues an app token for it (the body is never read).
    const res = await machineFetch(run.platform)(
      new Request(new URL(OAUTH_PATHS.token, run.env.HARNESS_API_URL), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: clientCredentialsForm(clientId, secret),
      }),
    );
    await res.body?.cancel();
    ctx.assert("the shown secret is the app's (client credentials succeed)", res.status === 200, {
      status: res.status,
    });
    await byE9Id(page, T.devappSecretDone).click(ui);
    await dialog.waitFor({ state: "detached", ...ui });
    ctx.assert("the secret is gone from the page after devapp-secret-done", !(await pageHolds(page, secret)));
    const row = byE9Id(page, T.devappRow, { "client-id": clientId });
    await row.waitFor(ui);
    const id = await attr(row, "data-app-id");
    const apps = await run.actors.developer.api.client.developer.apps.list();
    const listed = apps.find((a) => a.id === id);
    ctx.assert(
      "the API lists the app as confidential, not suspended",
      listed?.confidential === true && listed.suspended === null,
      {
        id,
        clientId,
      },
    );
    return { id, clientId };
  });
}

async function subscriptionsAndDeliveries(run: E9Run, page: Page): Promise<void> {
  const { ctx, state } = run;
  const app = state.confidentialApp;
  const subId = state.followSubscriptionId;
  if (!app || !subId) throw new Error("step 7 needs step 1's confidential app and step 4's subscription");
  const dev = run.actors.developer;

  const row = await ctx.step("7. the app page shows step 4's subscription enabled", async () => {
    await page.goto(new URL(E9_ROUTES.developerApp(app.id), ctx.env.HARNESS_WEB_URL).toString());
    await byE9Id(page, T.devapp, { "app-id": app.id }).waitFor(ui);
    ctx.assert(
      "devapp-client-id shows the client id",
      ((await byE9Id(page, T.devappClientId).textContent(ui)) ?? "").trim() === app.clientId,
    );
    const r = byE9Id(page, T.devsub, { "subscription-id": subId });
    await r.waitFor(ui);
    ctx.assert(
      "devsub is the channel.follow webhook, enabled",
      (await attr(r, "data-type")) === "channel.follow" &&
        (await attr(r, "data-transport")) === "webhook" &&
        (await attr(r, "data-status")) === "enabled",
    );
    return r;
  });

  const openLog = async () => {
    await byE9Id(row, T.devsubDeliveries).click(ui);
    await byE9Id(page, T.devdelivery).first().waitFor(ui);
  };
  const closeLog = async () => {
    await page.keyboard.press("Escape");
    await byE9Id(page, T.devdelivery)
      .first()
      .waitFor({ state: "detached", ...ui });
  };

  const before = await ctx.step("7. devsub-deliveries lists step 4's deliveries", async () => {
    const api = await allDeliveries(dev, subId);
    await openLog();
    const firstPage = api.slice(0, 25);
    await waitFor(
      "every delivery of the first page shown",
      async () => {
        const shown = await byE9Id(page, T.devdelivery).evaluateAll((els) =>
          els.map((e) => e.getAttribute("data-delivery-id")),
        );
        return firstPage.every((d) => shown.includes(d.id));
      },
      { timeoutMs: UI_TIMEOUT_MS },
    );
    ctx.assert(
      "the log has step 4's notification",
      api.some((d) => d.messageType === "notification"),
      { deliveries: api.length },
    );
    await closeLog();
    return api;
  });

  const afterTest = await ctx.step("7. devsub-test adds a delivery", async () => {
    await byE9Id(row, T.devsubTest).click(ui);
    const added = await waitFor(
      "the test notification is logged",
      async () => {
        const now = await allDeliveries(dev, subId);
        return newNotifications(before, now).length > 0 ? now : null;
      },
      { timeoutMs: DELIVERY_TIMEOUT_MS, intervalMs: 1000 },
    );
    await openLog();
    const fresh = newNotifications(before, added);
    await waitFor(
      "the test delivery shown in the log",
      async () => (await byE9Id(page, T.devdelivery, { "delivery-id": fresh[0]?.id ?? "" }).count()) > 0,
      { timeoutMs: DELIVERY_TIMEOUT_MS },
    );
    return added;
  });

  await ctx.step("7. devdelivery-redeliver adds an attempt of the follow notification", async () => {
    const target = redeliveryTarget(before);
    if (!target) throw new Error("no notification of step 4 to redeliver");
    const attempt = lastAttempt(afterTest, target.messageId);
    await byE9Id(byE9Id(page, T.devdelivery, { "delivery-id": target.id }), T.devdeliveryRedeliver).click(ui);
    const next = await waitFor(
      "a new attempt of the same message id",
      async () => {
        const now = await allDeliveries(dev, subId);
        return lastAttempt(now, target.messageId) > attempt ? now : null;
      },
      { timeoutMs: DELIVERY_TIMEOUT_MS, intervalMs: 1000 },
    );
    const want = String(lastAttempt(next, target.messageId));
    await waitFor(
      "the new attempt shown in the open log",
      async () => (await byE9Id(page, T.devdelivery, { attempt: want, "message-type": "notification" }).count()) > 0,
      { timeoutMs: DELIVERY_TIMEOUT_MS },
    );
    ctx.assert("redelivery logged as a new attempt", Number(want) === attempt + 1, { attempt, now: want });
    await closeLog();
  });
}

async function botAndToken(run: E9Run, page: Page): Promise<void> {
  const { ctx } = run;
  const username = consoleBotUsername(ctx.runId);
  await ctx.step("7. /developer/bots: create a bot and mint a token once", async () => {
    await page.goto(new URL(E9_ROUTES.developerBots, ctx.env.HARNESS_WEB_URL).toString());
    await byE9Id(page, T.devbots).waitFor(ui);
    await byE9Id(page, T.devbotNew).click(ui);
    await byE9Id(page, T.devbotForm).waitFor(ui);
    await byE9Id(page, T.devbotUsername).fill(username, ui);
    await byE9Id(page, T.devbotDisplayName).fill("Console bot", ui);
    await byE9Id(page, T.devbotSubmit).click(ui);
    const bot = byE9Id(page, T.devbot, { username });
    await bot.waitFor(ui);
    const botId = await attr(bot, "data-bot-id");
    await byE9Id(bot, T.devbotTokenNew).click(ui);
    await byE9Id(page, T.devbotTokenForm).waitFor(ui);
    await byE9Id(page, e9Option("devbot-scope", "chat:read")).click(ui);
    await byE9Id(page, e9Option("devbot-scope", "chat:edit")).click(ui);
    await byE9Id(page, T.devbotTokenDays).fill("7", ui);
    await byE9Id(page, T.devbotTokenSubmit).click(ui);
    const value = byE9Id(page, T.devbotTokenValue);
    await value.waitFor(ui);
    const token = ((await value.textContent(ui)) ?? "").trim();
    ctx.assert("devbot-token-value shows an access token", looksLikeAccessToken(token));
    const res = await fetch(new URL(OAUTH_PATHS.validate, run.env.HARNESS_API_URL), {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.ok ? ((await res.json()) as { login?: unknown; user_id?: unknown; scopes?: unknown }) : null;
    const scopes = Array.isArray(body?.scopes) ? body.scopes : [];
    ctx.assert(
      "oauth2/validate: the token is the bot's, with the two scopes",
      body?.login === username &&
        body.user_id === botId &&
        scopes.includes("chat:read") &&
        scopes.includes("chat:edit"),
      { status: res.status, login: body?.login ?? null },
    );
    await byE9Id(page, T.devbotTokenDone).click(ui);
    await value.waitFor({ state: "detached", ...ui });
    ctx.assert("the token is gone from the page after devbot-token-done", !(await pageHolds(page, token)));
    await waitFor(
      "a personal devtoken listed",
      async () => (await byE9Id(page, T.devtoken, { kind: "personal" }).count()) > 0,
      {
        timeoutMs: UI_TIMEOUT_MS,
      },
    );
  });
}

async function adminSuspend(run: E9Run, page: Page, app: { id: string; clientId: string }): Promise<void> {
  const { ctx } = run;
  const admin = run.actors.admin.api.client.developer.admin;
  const row = () => byE9Id(page, T.adminapp, { "app-id": app.id });
  await ctx.step("7. /admin/apps: find the third app, suspend it (spam)", async () => {
    await page.goto(new URL(E9_ROUTES.adminApps, ctx.env.HARNESS_WEB_URL).toString());
    await byE9Id(page, T.adminapps).waitFor(ui);
    await byE9Id(page, T.adminappsSearch).fill(app.clientId, ui);
    await row().waitFor(ui);
    ctx.assert("the row is not suspended yet", (await attr(row(), "data-suspended")) === "false");
    await byE9Id(row(), T.adminappSuspend).click(ui);
    await byE9Id(page, T.adminappSuspendForm).waitFor(ui);
    await byE9Id(page, e9Option(T.adminappReason, "spam")).click(ui);
    await byE9Id(page, T.adminappSuspendSubmit).click(ui);
    await confirmDialog(page);
    await byE9Id(page, T.adminapp, { "app-id": app.id, suspended: "true" }).waitFor(ui);
    const listed = (await admin.list({ q: app.clientId, limit: 10 })).items.find((a) => a.id === app.id);
    ctx.assert("the API has the app suspended for spam", listed?.suspended?.reason === "spam", { id: app.id });
  });
  await ctx.step("7. /admin/apps: lift the suspension", async () => {
    await byE9Id(row(), T.adminappUnsuspend).click(ui);
    await confirmDialog(page);
    await byE9Id(page, T.adminapp, { "app-id": app.id, suspended: "false" }).waitFor(ui);
    const listed = (await admin.list({ q: app.clientId, limit: 10 })).items.find((a) => a.id === app.id);
    ctx.assert("the API has the app no longer suspended", listed !== undefined && listed.suspended === null, {
      id: app.id,
    });
  });
}

export const step: E9Step = {
  name: "console",
  owner: "E9-console",
  ready: true,
  needs: [4],
  webOnly: true,
  async run(run) {
    const dev = await session(run, "developer", run.actors.developer);
    const adm = await session(run, "admin", run.actors.admin);
    await withScreenshots(run, [dev, adm], async () => {
      const page = await dev.page();
      const third = await registerThirdApp(run, page);
      await subscriptionsAndDeliveries(run, page);
      await botAndToken(run, page);
      await adminSuspend(run, await adm.page(), third);
    });
  },
};
