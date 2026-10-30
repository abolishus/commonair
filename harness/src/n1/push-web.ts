// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Step 7 (N1-pwa, web only; harness need `webPush`; docs/testing/n1-selectors.md): the push
 * toggle subscribes this browser, a go-live of the fourth streamer reaches the harness receiver and
 * decrypts, and signing out in that browser removes the subscription.
 *
 * Headless Chromium cannot subscribe without a vendor push service, so `PushManager.subscribe` and
 * `getSubscription` are replaced in the page by a subscription the harness made (`ece.ts`) whose
 * endpoint is its own receiver. Everything after that (the toggle, the API, the worker's
 * encryption and VAPID signature) is the real path.
 */
import type { Page } from "playwright";
import { waitLive } from "../e8/kit.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS } from "../web/selectors.ts";
import { decryptPushBody, newHarnessSubscription, verifyVapidAuthorization } from "./ece.ts";
import { openHydrated, pwaBrowserContext } from "./pwa.ts";
import type { N1Run, N1Step } from "./run.ts";
import { N1_ROUTES, N1_TEST_IDS, byN1Id } from "./selectors.ts";

const UI_TIMEOUT_MS = 20_000;
/** The toggle waits up to 10 s for the worker (registered when the page is idle), then reads the API. */
const TOGGLE_READY_MS = 45_000;
/** Outbox relay → fan-out job → push job → receiver, on a loaded CI runner. */
const PUSH_ARRIVAL_MS = 120_000;
const API_SETTLE_MS = 30_000;

/** The page's `sessionStorage` key that says the stub subscription exists (it survives navigation in the tab). */
export const STUB_STORAGE_KEY = "__harnessPushSubscribed";

export interface PushStubArgs {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  storageKey: string;
}

/**
 * Init script: `PushManager.prototype.subscribe` returns the harness subscription and
 * `getSubscription` returns it while subscribed; `unsubscribe()` forgets it. Only the shape the
 * web app reads (`endpoint`, `toJSON()`, `unsubscribe()`). Runs in every page before the app.
 */
export function installPushStub(args: PushStubArgs): void {
  if (typeof PushManager === "undefined") return;
  const { endpoint, keys, storageKey } = args;
  const make = () => ({
    endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey: () => null,
    toJSON: () => ({ endpoint, expirationTime: null, keys: { ...keys } }),
    unsubscribe: () => {
      sessionStorage.removeItem(storageKey);
      return Promise.resolve(true);
    },
  });
  const proto = PushManager.prototype as unknown as Record<string, unknown>;
  proto.subscribe = function subscribe() {
    sessionStorage.setItem(storageKey, "1");
    return Promise.resolve(make());
  };
  proto.getSubscription = function getSubscription() {
    return Promise.resolve(sessionStorage.getItem(storageKey) === "1" ? make() : null);
  };
}

/** What the decrypted go-live push must be; empty when it is. */
export function goLivePushProblems(plaintext: string, slug: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    return ["the decrypted body is not JSON"];
  }
  if (typeof payload !== "object" || payload === null) return ["the decrypted body is not an object"];
  const p = payload as Record<string, unknown>;
  const problems: string[] = [];
  if (p.v !== 1) problems.push(`v is ${JSON.stringify(p.v)}`);
  if (p.type !== "go_live") problems.push(`type is ${JSON.stringify(p.type)}`);
  if (p.slug !== slug) problems.push(`slug is ${JSON.stringify(p.slug)}, expected ${slug}`);
  if (typeof p.title !== "string") problems.push("no title");
  const extra = Object.keys(p).filter((k) => !["v", "type", "slug", "title"].includes(k));
  if (extra.length > 0) problems.push(`unexpected fields ${extra.join(", ")}`);
  return problems;
}

/** The account menu's sign-out entry. */
export const SIGN_OUT_ITEM = `[data-testid="${N1_TEST_IDS.signOut}"]`;

async function toggleState(page: Page): Promise<string | null> {
  return byN1Id(page, N1_TEST_IDS.pushToggle).first().getAttribute("data-state", { timeout: UI_TIMEOUT_MS });
}

async function waitToggle(page: Page, want: string, timeoutMs: number): Promise<void> {
  await byN1Id(page, N1_TEST_IDS.pushToggle, { state: want })
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs })
    .catch(async (err: unknown) => {
      const seen = await toggleState(page).catch(() => null);
      throw new Error(`push-toggle did not reach "${want}" (data-state=${seen}): ${(err as Error).message}`);
    });
}

async function run(r: N1Run): Promise<void> {
  const { ctx } = r;
  const { viewer } = r.actors;
  const streamer = r.actors.streamers[3];
  const webUrl = ctx.env.HARNESS_WEB_URL;
  const origin = new URL(webUrl).origin;
  const api = viewer.api.client;

  const status = await api.notifications.push.status();
  if (!status.enabled || !status.vapidPublicKey)
    throw new Error("notifications.push.status: push is off on this stack");
  const before = status.subscriptions;

  // The fourth streamer's channel has never gone live: no cooldown stands in the way.
  await api.channels.follow({ channel: streamer.channel, notify: true });

  const id = `web_${crypto.randomUUID().replaceAll("-", "")}`;
  const sub = await newHarnessSubscription(r.receiver.endpoint(id));
  const context = await pwaBrowserContext(ctx, origin);
  await context.addInitScript(installPushStub, {
    endpoint: sub.endpoint,
    keys: sub.keys,
    storageKey: STUB_STORAGE_KEY,
  });

  const page = await openHydrated(context, webUrl, ROUTES.signin);
  await signInViaUi(page, viewer, UI_TIMEOUT_MS, ctx.signal);
  await openHydrated(context, webUrl, N1_ROUTES.settings, page);

  await waitToggle(page, "off", TOGGLE_READY_MS);
  await byN1Id(page, N1_TEST_IDS.pushToggle).first().click({ timeout: UI_TIMEOUT_MS });
  await waitToggle(page, "on", UI_TIMEOUT_MS);
  await waitFor(
    `push.status().subscriptions = ${before + 1}`,
    async () => (await api.notifications.push.status()).subscriptions === before + 1,
    { timeoutMs: API_SETTLE_MS, intervalMs: 500, signal: ctx.signal },
  );
  const prefs = await api.notifications.preferences.get({ type: "go_live" });
  if (!prefs.defaults.push) throw new Error("turning push on did not turn the go-live push default on");

  const publisher = await ctx.platform.streamerFor(streamer.user, {
    protocol: "rtmp",
    width: 640,
    height: 360,
    bitrateKbps: 800,
  });
  ctx.defer(() => publisher.stop());
  await publisher.start();
  await waitLive(ctx, streamer.channel);
  r.state.webPushChannel = streamer.channel;

  const received = await r.receiver.waitFor((req) => req.id === id, PUSH_ARRIVAL_MS);
  const claims = await verifyVapidAuthorization(
    received.headers.authorization ?? "",
    sub.endpoint,
    status.vapidPublicKey,
    Date.now(),
  );
  const plaintext = new TextDecoder().decode(await decryptPushBody(received.body, sub));
  const problems = goLivePushProblems(plaintext, streamer.channel);
  if (problems.length > 0) throw new Error(`go-live push: ${problems.join("; ")}`);
  await publisher.stop();

  // Sign out in that browser: the app forgets the subscription on the API and in the browser.
  await page.locator(`[data-testid="${TEST_IDS.navUser}"] button`).first().click({ timeout: UI_TIMEOUT_MS });
  await page.locator(SIGN_OUT_ITEM).first().click({ timeout: UI_TIMEOUT_MS });
  await page.waitForURL((url) => url.pathname === "/", { timeout: UI_TIMEOUT_MS });
  await page
    .locator(`[data-testid="${TEST_IDS.navUser}"]`)
    .first()
    .waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
  await waitFor(
    `push.status().subscriptions back to ${before} after sign-out`,
    async () => (await api.notifications.push.status()).subscriptions === before,
    { timeoutMs: API_SETTLE_MS, intervalMs: 500, signal: ctx.signal },
  );
  const stillSubscribed = await page.evaluate((key) => sessionStorage.getItem(key), STUB_STORAGE_KEY);
  if (stillSubscribed !== null) throw new Error("sign-out left the browser's push subscription in place");

  ctx.data("n1.pushWeb", {
    channel: streamer.channel,
    contentEncoding: received.headers["content-encoding"],
    ttl: received.headers.ttl,
    vapidAud: claims.aud,
    subscriptionsBefore: before,
  });
}

export const step: N1Step = {
  name: "push from the browser",
  owner: "N1-pwa",
  needs: [4, 6],
  webOnly: true,
  requires: ["webPush"],
  run,
};
