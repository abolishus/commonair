// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 3 (E9-consent; docs/testing/e9-selectors.md "Scenarios" 3), in
 * Chromium with the streamer's own browser context:
 *
 * 1. Open the confidential app's authorize URL signed out → `/signin` → sign in → back on the
 *    consent (`force_verify=true`: step 2 already granted these scopes, which would otherwise
 *    approve silently) → one `oauth-consent-scope` per requested scope → approve → the receiver's
 *    `/cb` gets a `code` and the same `state` → the code exchanges at the token endpoint.
 * 2. Without `force_verify` the existing grant approves at once (no card).
 * 3. A second request, denied → `/cb` gets `error=access_denied` and its `state`.
 * 4. The public app starts a device authorization; the streamer types the user code on
 *    `/activate`, approves → `device-done` `approved` → the token endpoint issues a token.
 * 5. `/settings/connections` lists the confidential app with every requested scope.
 *
 * Reports ids and outcomes only: never a code, token, verifier, user code or secret.
 */
import { join } from "node:path";
import { DEVICE_CODE_GRANT, OAUTH_PATHS } from "@commonair/contracts/oauth";
import type { Scope } from "@commonair/contracts/scopes";
import type { Page } from "playwright";
import { playerBundles } from "../player-server.ts";
import { DEFAULT_REPORT_DIR } from "../report.ts";
import { sleep } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { TEST_IDS } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import { STEP2_SCOPES, newPkcePair, postForm } from "./oauth.ts";
import type { ReceivedRequest } from "./receiver.ts";
import { type E9App, type E9Run, type E9Step } from "./run.ts";
import { E9_ROUTES, E9_TEST_IDS as T, byE9Id } from "./selectors.ts";

/** A page action plus one API round trip. */
export const UI_TIMEOUT_MS = 20_000;
/** How long the device flow may take to issue its token after approval. */
export const DEVICE_TOKEN_TIMEOUT_MS = 60_000;
/** The scopes step 3 asks the confidential app for (step 2's, so step 5's grant is unaffected). */
export const STEP3_SCOPES: readonly Scope[] = STEP2_SCOPES;
/** The public app's device request. */
export const STEP3_DEVICE_SCOPES: readonly Scope[] = ["chat:read"];

// ---------------------------------------------------------------- pure helpers

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scopes: readonly Scope[];
  state: string;
  challenge: string;
  forceVerify?: boolean;
}

/** The consent page URL an app sends the browser to (RFC 6749 §4.1.1 names, PKCE S256). */
export function authorizeUrl(webUrl: string, r: AuthorizeRequest): string {
  const url = new URL(E9_ROUTES.authorize, webUrl);
  url.searchParams.set("client_id", r.clientId);
  url.searchParams.set("redirect_uri", r.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", r.scopes.join(" "));
  url.searchParams.set("state", r.state);
  url.searchParams.set("code_challenge", r.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (r.forceVerify) url.searchParams.set("force_verify", "true");
  return url.href;
}

/** The receiver request that answers one authorization: `GET /cb` carrying that `state`. */
export function isCallbackFor(state: string): (r: ReceivedRequest) => boolean {
  return (r) => r.method === "GET" && r.path === "/cb" && r.query.state === state;
}

export type CallbackOutcome = { kind: "code"; code: string } | { kind: "error"; error: string } | { kind: "empty" };

/** What the app's redirect URI received. */
export function callbackOutcome(r: Pick<ReceivedRequest, "query">): CallbackOutcome {
  if (r.query.error) return { kind: "error", error: r.query.error };
  if (r.query.code) return { kind: "code", code: r.query.code };
  return { kind: "empty" };
}

/** `data-scopes` of a `connection` row (space-separated) as a list. */
export function scopesOf(attr: string | null): string[] {
  return (attr ?? "").split(" ").filter(Boolean);
}

/** The consent shows exactly the requested scopes, one row each (order free). */
export function sameScopes(shown: readonly (string | null)[], requested: readonly string[]): boolean {
  const left = shown.map((s) => s ?? "").sort((a, b) => a.localeCompare(b));
  const right = [...requested].sort((a, b) => a.localeCompare(b));
  return left.length === right.length && left.every((s, i) => s === right[i]);
}

/** Every requested scope is among those listed. */
export function coversScopes(listed: readonly string[], requested: readonly string[]): boolean {
  return requested.every((s) => listed.includes(s));
}

/** RFC 8628 §3.5: wait `interval` between polls, five seconds more after each `slow_down`. */
export function nextDeviceInterval(intervalS: number, error: string | null): number {
  return error === "slow_down" ? intervalS + 5 : intervalS;
}

// ---------------------------------------------------------------- browser plumbing

const ui = { timeout: UI_TIMEOUT_MS };

async function openSession(run: E9Run): Promise<WebSession> {
  const { ctx } = run;
  const session = await WebSession.open({
    fleet: run.browser ?? run.platform.fleet,
    engine: "chromium",
    webUrl: run.env.HARNESS_WEB_URL,
    probeScript: (await playerBundles()).probe,
    label: "e9-consent",
    log: run.log,
  });
  ctx.defer(() => session.close());
  return session;
}

/** Run `fn`; on failure write screenshots of the session's pages to the report, then rethrow. */
async function withScreenshots<R>(run: E9Run, session: WebSession, fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    const dir = join(run.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${run.ctx.runId}-${run.ctx.name}`);
    // The device code input is blanked: never a user code in a screenshot.
    const files = await session.screenshotAll(dir, [`[data-testid="${T.deviceCode}"]`]);
    if (files.length > 0) run.ctx.data("consentScreenshots", files);
    throw err;
  }
}

async function shownScopes(page: Page): Promise<(string | null)[]> {
  const rows = byE9Id(page, T.oauthConsentScope);
  return Promise.all((await rows.all()).map((r) => r.getAttribute("data-scope")));
}

// ---------------------------------------------------------------- the step

async function approveSignedOut(run: E9Run, session: WebSession, app: E9App): Promise<void> {
  const { ctx } = run;
  const streamer = run.actors.streamer.user;
  const pkce = await newPkcePair();
  const state = crypto.randomUUID();
  const page = await session.goto(
    authorizeUrl(run.env.HARNESS_WEB_URL, {
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      scopes: STEP3_SCOPES,
      state,
      challenge: pkce.challenge,
      forceVerify: true,
    }),
  );
  await byTestId(page, TEST_IDS.signinEmail).waitFor(ui);
  ctx.assert("3. signed out: the consent sends the browser to /signin", new URL(page.url()).pathname === "/signin");
  await signInViaUi(page, streamer, UI_TIMEOUT_MS, ctx.signal);

  const card = byE9Id(page, T.oauthConsent, { "client-id": app.clientId });
  await card.waitFor(ui);
  ctx.assert(
    "3. signed in: back on the consent for the same request",
    new URL(page.url()).pathname === E9_ROUTES.authorize,
  );
  const owner = await byE9Id(page, T.oauthConsentOwner).getAttribute("data-username", ui);
  ctx.check("3. the consent names the developer", owner === run.actors.developer.username, { owner });
  const shown = await shownScopes(page);
  ctx.assert("3. one oauth-consent-scope per requested scope", sameScopes(shown, STEP3_SCOPES), { shown });

  await byE9Id(page, T.oauthConsentApprove).click(ui);
  const back = await run.state.receiver.waitFor(isCallbackFor(state), UI_TIMEOUT_MS);
  const outcome = callbackOutcome(back);
  ctx.assert("3. approve: /cb gets a code and the same state", outcome.kind === "code", { kind: outcome.kind });
  if (outcome.kind !== "code") return;

  const token = await postForm(run, OAUTH_PATHS.token, {
    grant_type: "authorization_code",
    code: outcome.code,
    redirect_uri: app.redirectUri,
    code_verifier: pkce.verifier,
    client_id: app.clientId,
    ...(app.clientSecret === null ? {} : { client_secret: app.clientSecret }),
  });
  ctx.assert("3. the consent's code exchanges for tokens", token.status === 200 && token.accessToken !== null, {
    status: token.status,
    error: token.error,
  });
}

/** An existing grant without `force_verify`: straight back to the app with a code, no card. */
async function approveSilently(run: E9Run, session: WebSession, app: E9App): Promise<void> {
  const { ctx } = run;
  const state = crypto.randomUUID();
  // No hydration wait: the page leaves for the receiver as soon as it has hydrated.
  const page = await session.page();
  await page.goto(
    authorizeUrl(run.env.HARNESS_WEB_URL, {
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      scopes: STEP3_SCOPES,
      state,
      challenge: (await newPkcePair()).challenge,
    }),
    { waitUntil: "commit", timeout: UI_TIMEOUT_MS },
  );
  const back = await run.state.receiver.waitFor(isCallbackFor(state), UI_TIMEOUT_MS);
  ctx.check("3. already granted: back to the app with a code, no card", callbackOutcome(back).kind === "code", {
    kind: callbackOutcome(back).kind,
  });
}

async function deny(run: E9Run, session: WebSession, app: E9App): Promise<void> {
  const { ctx } = run;
  const state = crypto.randomUUID();
  const page = await session.goto(
    authorizeUrl(run.env.HARNESS_WEB_URL, {
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      scopes: STEP3_SCOPES,
      state,
      challenge: (await newPkcePair()).challenge,
      forceVerify: true,
    }),
  );
  await byE9Id(page, T.oauthConsent, { "client-id": app.clientId }).waitFor(ui);
  await byE9Id(page, T.oauthConsentDeny).click(ui);
  const back = await run.state.receiver.waitFor(isCallbackFor(state), UI_TIMEOUT_MS);
  const outcome = callbackOutcome(back);
  ctx.assert(
    "3. deny: /cb gets error=access_denied and the same state",
    outcome.kind === "error" && outcome.error === "access_denied",
    { kind: outcome.kind, error: outcome.kind === "error" ? outcome.error : null },
  );
}

async function activateDevice(run: E9Run, session: WebSession, app: E9App): Promise<void> {
  const { ctx } = run;
  const start = await postForm(run, OAUTH_PATHS.device, {
    scope: STEP3_DEVICE_SCOPES.join(" "),
    client_id: app.clientId,
    ...(app.clientSecret === null ? {} : { client_secret: app.clientSecret }),
  });
  ctx.assert("3. device authorization starts", start.status === 200, { status: start.status, error: start.error });
  const deviceCode = String(start.body.device_code);
  const userCode = String(start.body.user_code);
  let interval = Number(start.body.interval) || 5;

  // Typed like a person would, never put in a URL the page requests.
  const page = await session.goto(E9_ROUTES.activate);
  await byE9Id(page, T.deviceCode).fill(userCode.toLowerCase(), ui);
  await byE9Id(page, T.deviceSubmit).click(ui);
  await byE9Id(page, T.deviceConsent, { "client-id": app.clientId }).waitFor(ui);
  const shown = await shownScopes(page);
  ctx.check("3. device consent lists the device's scopes", sameScopes(shown, STEP3_DEVICE_SCOPES), { shown });
  await byE9Id(page, T.deviceApprove).click(ui);
  const done = byE9Id(page, T.deviceDone);
  await done.waitFor(ui);
  ctx.assert("3. /activate: device-done approved", (await done.getAttribute("data-result")) === "approved");

  const deadline = Date.now() + DEVICE_TOKEN_TIMEOUT_MS;
  let last: { status: number; error: string | null } = { status: 0, error: null };
  while (Date.now() < deadline) {
    await sleep(interval * 1000, ctx.signal);
    const answer = await postForm(run, OAUTH_PATHS.token, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: app.clientId,
      ...(app.clientSecret === null ? {} : { client_secret: app.clientSecret }),
    });
    last = { status: answer.status, error: answer.error };
    if (answer.status === 200 || (answer.error !== "authorization_pending" && answer.error !== "slow_down")) break;
    interval = nextDeviceInterval(interval, answer.error);
  }
  ctx.assert("3. device: approved on /activate → token", last.status === 200, last);
}

async function connections(run: E9Run, session: WebSession, conf: E9App, pub: E9App): Promise<void> {
  const { ctx } = run;
  const page = await session.goto(E9_ROUTES.connections);
  await byE9Id(page, T.connections).waitFor(ui);
  const row = byE9Id(page, T.connection, { "client-id": conf.clientId });
  await row.waitFor(ui);
  const listed = scopesOf(await row.getAttribute("data-scopes"));
  ctx.assert("3. /settings/connections lists the app with its scopes", coversScopes(listed, STEP3_SCOPES), {
    appId: conf.id,
    scopes: listed,
  });
  ctx.check(
    "3. /settings/connections lists the device's app too",
    (await byE9Id(page, T.connection, { "client-id": pub.clientId }).count()) === 1,
    { appId: pub.id },
  );
}

export const step: E9Step = {
  name: "consent",
  owner: "E9-consent",
  ready: true,
  needs: [1],
  webOnly: true,
  async run(run) {
    const conf = run.state.confidentialApp;
    const pub = run.state.publicApp;
    if (!conf || !pub) throw new Error("step 3 needs step 1's apps");
    const session = await openSession(run);
    await withScreenshots(run, session, async () => {
      await approveSignedOut(run, session, conf);
      await approveSilently(run, session, conf);
      await deny(run, session, conf);
      await activateDevice(run, session, pub);
      await connections(run, session, conf, pub);
    });
  },
};
