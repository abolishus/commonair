// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E1 end to end, through the real web app: a streamer signs up in Chromium (ALTCHA,
 * email verification from Mailpit), copies the server URL and a fresh stream key from the
 * dashboard and publishes an ffmpeg RTMP test pattern; a signed-in viewer in Chromium and an
 * anonymous viewer in WebKit watch the channel page (TTFF and glass-to-glass latency from the
 * probe); the signed-in viewer chats and everyone sees it; the stream stops and every page and
 * the API report offline. Selects only by the test ids in docs/testing/e1-selectors.md.
 */
import { join } from "node:path";
import type { Page } from "playwright";
import { summarize } from "../src/metrics.ts";
import { playerBundles } from "../src/player-server.ts";
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import { Streamer } from "../src/streamer.ts";
import { findTokenLink } from "../src/mailpit.ts";
import { waitFor } from "../src/wait.ts";
import { ROUTES, TEST_IDS as T } from "../src/web/selectors.ts";
import { WebSession, byTestId, probeStats, readValue } from "../src/web/session.ts";
import { browserVerificationUrl, obsPublishUrl, rebaseOrigin } from "../src/web/urls.ts";

/** Generous first thresholds (soft checks); tighten once the stack has a baseline. */
export const E2E_MAX_TTFF_MS = 15_000;
export const E2E_MAX_GLASS_TO_GLASS_MS = 20_000;

const UI_TIMEOUT_MS = 20_000;
const ALTCHA_TIMEOUT_MS = 60_000;
const PLAYING_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 20_000;
const OFFLINE_TIMEOUT_MS = 60_000;
const LATENCY_SAMPLES = 5;

export default defineScenario({
  name: "e2e-basic",
  description:
    "web sign-up + email verification → dashboard stream key → RTMP publish → Chromium (signed in) + WebKit (anonymous) watch → chat → offline",
  needs: ["api", "web", "mail", "chat", "media", "origin", "ffmpeg", "browser"],
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const sessions: WebSession[] = [];
    try {
      await e2eBasic(ctx, sessions);
    } catch (err) {
      await screenshotSessions(ctx, sessions);
      throw err;
    }
  },
});

async function screenshotSessions(ctx: ScenarioContext, sessions: readonly WebSession[]): Promise<void> {
  const dir = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${ctx.runId}-${ctx.name}`);
  const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir)))).flat();
  if (files.length > 0) {
    ctx.data("screenshots", files);
    ctx.log.info("failure screenshots written", { dir, count: files.length });
  }
}

async function e2eBasic(ctx: ScenarioContext, sessions: WebSession[]): Promise<void> {
  const p = ctx.platform;
  const webUrl = ctx.env.HARNESS_WEB_URL;
  const { probe } = await playerBundles();
  const openSession = async (label: string, engine: "chromium" | "webkit") => {
    const s = await WebSession.open({ fleet: p.fleet, engine, webUrl, probeScript: probe, label, log: ctx.log });
    sessions.push(s);
    ctx.defer(() => s.close());
    return s;
  };

  // 1. Streamer signs up through the web UI.
  const creds = p.users.credentials({ prefix: "e2e_st" });
  const streamer = await openSession("streamer", "chromium");
  const signup = await ctx.step("streamer: fill the sign-up form", async () => {
    const page = await streamer.goto(ROUTES.signup);
    await byTestId(page, T.signupEmail).fill(creds.email, { timeout: UI_TIMEOUT_MS });
    await byTestId(page, T.signupUsername).fill(creds.username);
    await byTestId(page, T.signupPassword).fill(creds.password);
    await byTestId(page, T.signupBirthdate).fill(creds.birthDate);
    await byTestId(page, T.signupLegal).check();
    return page;
  });
  await ctx.step("streamer: ALTCHA verified", () => waitForAltcha(signup, ctx.signal));
  await ctx.step("streamer: submit sign-up", async () => {
    await byTestId(signup, T.signupSubmit).click({ timeout: UI_TIMEOUT_MS });
    await waitForOneOf(signup, [T.signupCheckEmail], UI_TIMEOUT_MS);
  });

  const link = await ctx.step("streamer: verification email", async () => {
    const message = await p.mailpit.waitForMessage(creds.email, (m) => findTokenLink(m) !== null, 30_000);
    const found = findTokenLink(message);
    if (!found) throw new Error("verification email has no link");
    return browserVerificationUrl(found, webUrl);
  });
  await ctx.step("streamer: follow the link and end up signed in", async () => {
    const page = await streamer.goto(link);
    const landed = await waitFor(
      "verification link to land on /dashboard or /signin",
      async () => {
        if (await byTestId(page, T.navUser).count()) return "signed-in";
        const path = new URL(page.url()).pathname;
        return path === ROUTES.signin && (await byTestId(page, T.signinEmail).count()) ? "signin" : null;
      },
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
    );
    ctx.data("verificationLanding", landed);
    if (landed === "signin") await signInViaUi(page, creds.email, creds.password);
  });
  const main = await streamer.page();
  const navName = await ctx.step("streamer: nav shows the username", async () => {
    await byTestId(main, T.navUser).waitFor({ timeout: UI_TIMEOUT_MS });
    return byTestId(main, T.navUser).getAttribute("data-username");
  });
  ctx.assert("nav-user data-username is the streamer", navName === creds.username, { navName });
  const channel = creds.username;

  // 2. Dashboard: server URL + a freshly rotated key → RTMP publish, as OBS would.
  const { server, key } = await ctx.step("streamer: read server URL and rotate the stream key", async () => {
    const page = await streamer.goto(ROUTES.dashboard);
    const serverUrl = await readValue(byTestId(page, T.streamServerUrl), UI_TIMEOUT_MS);
    await byTestId(page, T.streamKeyRotate).click({ timeout: UI_TIMEOUT_MS });
    const first = await waitForOneOf(page, [T.streamKey, T.confirmDialogConfirm], UI_TIMEOUT_MS);
    if (first === T.confirmDialogConfirm) await byTestId(page, T.confirmDialogConfirm).click();
    const streamKey = await readValue(byTestId(page, T.streamKey), UI_TIMEOUT_MS);
    return { server: serverUrl, key: streamKey };
  });
  ctx.assert("dashboard shows an RTMP server URL", /^rtmps?:\/\//.test(server), { server });
  ctx.assert("dashboard shows the new stream key", key.length > 0);
  // `--set ingest=harness` publishes to HARNESS_RTMP_URL when the public ingest host is not
  // reachable from the harness host.
  const shown = obsPublishUrl(server, key);
  const publishUrl = ctx.param("ingest", "web") === "harness" ? rebaseOrigin(shown, ctx.env.HARNESS_RTMP_URL) : shown;
  const encoder = new Streamer({ protocol: "rtmp", url: publishUrl, name: `streamer-${channel}`, log: ctx.log });
  ctx.defer(() => encoder.stop());
  await ctx.step("publish the RTMP test pattern", () => encoder.start());
  const toLive = await ctx.step("channel goes live (API)", () => p.waitForLive(channel, true, 30_000));
  ctx.metric("time_to_live", toLive, "ms");

  // 3. A signed-in viewer in Chromium and an anonymous viewer in WebKit.
  const fan = await ctx.step("sign up the second user (API)", () => p.signUp({ prefix: "e2e_fan" }));
  const fanSession = await openSession("fan", "chromium");
  await ctx.step("fan: sign in through the web UI", async () => {
    const page = await fanSession.goto(ROUTES.signin);
    await signInViaUi(page, fan.email, fan.password);
    await byTestId(page, T.navUser, { username: fan.username }).waitFor({ timeout: UI_TIMEOUT_MS });
  });
  const anon = await openSession("anon", "webkit");
  const watchers: { who: string; engine: "chromium" | "webkit"; page: Page; openedAt: number }[] = [];
  for (const [who, session] of [
    ["fan", fanSession],
    ["anon", anon],
  ] as const) {
    const openedAt = performance.now();
    const page = await ctx.step(`${who}: open /${channel}`, () => session.goto(ROUTES.channel(channel)));
    watchers.push({ who, engine: session.engine, page, openedAt });
  }
  for (const w of watchers) {
    await ctx.step(`${w.who} (${w.engine}): live badge and playing`, async () => {
      await byTestId(w.page, T.liveBadge).waitFor({ state: "visible", timeout: PLAYING_TIMEOUT_MS });
      await byTestId(w.page, T.player, { state: "playing" }).waitFor({ timeout: PLAYING_TIMEOUT_MS });
    });
    const ttff = await ctx.step(`${w.who} (${w.engine}): first frame`, () =>
      waitFor(
        `first frame on ${w.who}'s page`,
        async () => {
          const v = (await probeStats(w.page))[0];
          return v?.ttffMs ?? null;
        },
        { timeoutMs: PLAYING_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
      ),
    );
    ctx.metric(`ttff.${w.engine}`, ttff, "ms");
    ctx.metric(`page_to_first_frame.${w.engine}`, Math.round(performance.now() - w.openedAt), "ms");
    ctx.check(`${w.engine}: TTFF under ${E2E_MAX_TTFF_MS} ms`, ttff < E2E_MAX_TTFF_MS, { ttff });
    const samples = await waitFor(
      `latency samples on ${w.who}'s page`,
      async () => {
        const v = (await probeStats(w.page))[0];
        return v && v.latencyMs.length >= LATENCY_SAMPLES ? v.latencyMs : null;
      },
      { timeoutMs: 30_000, intervalMs: 500, signal: ctx.signal },
    ).catch(async (err: unknown) => {
      ctx.log.warn("no glass-to-glass samples", { engine: w.engine, error: (err as Error).message });
      return (await probeStats(w.page))[0]?.latencyMs ?? [];
    });
    const latency = summarize(samples);
    ctx.metric(`glass_to_glass.${w.engine}.p50`, latency.p50, "ms");
    ctx.metric(`glass_to_glass.${w.engine}.p95`, latency.p95, "ms");
    ctx.check(
      `${w.engine}: glass-to-glass under ${E2E_MAX_GLASS_TO_GLASS_MS} ms`,
      (latency.p50 ?? Infinity) < E2E_MAX_GLASS_TO_GLASS_MS,
      latency,
    );
  }
  const [fanWatch, anonWatch] = watchers;
  if (!fanWatch || !anonWatch) throw new Error("viewer pages missing");

  // 4. Chat: the fan writes, the streamer (own channel page) and the anonymous viewer read.
  const ownPage = await ctx.step("streamer: open the own channel page", async () => {
    const page = await streamer.goto(ROUTES.channel(channel), "channel");
    await byTestId(page, T.chat, { state: "open" }).waitFor({ timeout: CHAT_TIMEOUT_MS });
    return page;
  });
  await ctx.step("anon: chat open, no input", async () => {
    await byTestId(anonWatch.page, T.chat, { state: "open" }).waitFor({ timeout: CHAT_TIMEOUT_MS });
  });
  const anonInput = byTestId(anonWatch.page, T.chatInput);
  const anonCanType = (await anonInput.count()) > 0 && (await anonInput.first().isEnabled());
  ctx.check("anonymous viewer cannot type in chat", !anonCanType);
  ctx.check(
    "anonymous viewer sees the sign-in prompt",
    (await byTestId(anonWatch.page, T.chatSigninPrompt).count()) > 0,
  );

  const text = `hello from ${fan.username} ${ctx.runId}`;
  await ctx.step("fan: send a chat message", async () => {
    await byTestId(fanWatch.page, T.chat, { state: "open" }).waitFor({ timeout: CHAT_TIMEOUT_MS });
    await byTestId(fanWatch.page, T.chatInput).fill(text, { timeout: UI_TIMEOUT_MS });
    await byTestId(fanWatch.page, T.chatSend).click();
  });
  for (const [who, page] of [
    ["fan", fanWatch.page],
    ["streamer", ownPage],
    ["anon", anonWatch.page],
  ] as const) {
    await ctx.step(`${who}: sees the message`, () =>
      byTestId(page, T.chatMessage, { author: fan.username })
        .filter({ hasText: text })
        .first()
        .waitFor({ timeout: CHAT_TIMEOUT_MS }),
    );
  }

  // 5. AGPL source link.
  const href = await byTestId(anonWatch.page, T.footerSourceLink)
    .first()
    .getAttribute("href", { timeout: UI_TIMEOUT_MS });
  ctx.assert("footer source link has an href", typeof href === "string" && href.trim().length > 0, { href });

  // 6. Stop the stream: viewers and the API go offline.
  await ctx.step("stop publishing", () => encoder.stop());
  for (const w of watchers) {
    await ctx.step(`${w.who} (${w.engine}): offline state`, () =>
      byTestId(w.page, T.offlineState).waitFor({ state: "visible", timeout: OFFLINE_TIMEOUT_MS }),
    );
  }
  const toOffline = await ctx.step("channel goes offline (API)", () =>
    p.waitForLive(channel, false, OFFLINE_TIMEOUT_MS),
  );
  ctx.metric("time_to_offline", toOffline, "ms");
}

async function signInViaUi(page: Page, email: string, password: string): Promise<void> {
  await byTestId(page, T.signinEmail).fill(email, { timeout: UI_TIMEOUT_MS });
  await byTestId(page, T.signinPassword).fill(password);
  await byTestId(page, T.signinSubmit).click();
  await waitForOneOf(page, [T.navUser], UI_TIMEOUT_MS);
}

/**
 * Wait for the ALTCHA wrapper to report `verified`. Widgets configured to solve on load need
 * nothing; otherwise click the widget's checkbox once, like a person would.
 */
async function waitForAltcha(page: Page, signal: AbortSignal): Promise<void> {
  const verified = byTestId(page, T.signupAltcha, { state: "verified" });
  const started = Date.now();
  const deadline = started + ALTCHA_TIMEOUT_MS;
  let clicked = false;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    if (await verified.count()) return;
    const form = await byTestId(page, T.formError).count();
    if (form) throw new Error(`sign-up form error: ${await readValue(byTestId(page, T.formError))}`);
    if (!clicked && Date.now() - started > 3_000) {
      const box = page.locator(`[data-testid="${T.signupAltcha}"] input[type="checkbox"]`);
      if (await box.count())
        await box
          .first()
          .click({ timeout: 5_000 })
          .catch(() => undefined);
      clicked = true;
    }
    await page.waitForTimeout(250);
  }
  const state = await byTestId(page, T.signupAltcha)
    .getAttribute("data-state")
    .catch(() => null);
  throw new Error(`ALTCHA not verified within ${ALTCHA_TIMEOUT_MS} ms (data-state=${state})`);
}

/** Wait until one of the test ids is visible; returns which. A form error fails immediately. */
async function waitForOneOf<T extends string>(page: Page, ids: readonly T[], timeoutMs: number): Promise<T> {
  const formError = page.locator(`[data-testid="${T.formError}"]`).first();
  const seen = await waitFor(
    `one of ${ids.join(", ")}`,
    async () => {
      for (const id of ids) {
        if (await page.locator(`[data-testid="${id}"]`).first().isVisible()) return { id };
      }
      return (await formError.isVisible()) ? { id: null } : null;
    },
    { timeoutMs, intervalMs: 200 },
  );
  if (seen.id === null) throw new Error(`form error: ${await readValue(formError, 1_000)}`);
  return seen.id;
}
